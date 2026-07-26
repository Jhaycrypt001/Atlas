/**
 * REAL X Layer settlement. Deploys the non-custodial Escrow contract per
 * agreement and skims the fee on release. Uses the compiled contract artifact
 * and mirrors the proven deploy.mjs flow (approve + lock + release).
 *
 * On-chain writes are serialized with an explicit manual nonce counter so
 * concurrent agent tasks never collide (one wallet, sequential nonces).
 *
 * Wire in via buildAgent({ settlement: new XLayerSettlement() }).
 * Requires: XLAYER_RPC, PK (funded agent key), and a token address (XLAYER_USDC).
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Settlement, SettlementTx, FEE_BPS } from './settlement';

const RPC = process.env.XLAYER_RPC || 'https://rpc.xlayer.tech';
const CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID || 196);
const USDC = (process.env.XLAYER_USDC || '0x0000000000000000000000000000000000000000') as `0x${string}`;
const TREASURY = (process.env.XLAYER_TREASURY || '0x0000000000000000000000000000000000000000') as `0x${string}`;
const ATTESTATION = (process.env.XLAYER_ATTESTATION || '0x0000000000000000000000000000000000000000') as `0x${string}`;

function load(name: string) {
  return JSON.parse(readFileSync(new URL(`../../artifacts/${name}.json`, import.meta.url)) as any);
}
const ESCROW = load('Escrow');

// Capabilities pass a token SYMBOL ('USDC'); the chain needs an ADDRESS.
function tokenAddr(t?: string): `0x${string}` {
  if (t && /^0x[a-fA-F0-9]{40}$/.test(t)) return t as `0x${string}`;
  return USDC;
}

const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

export class XLayerSettlement implements Settlement {
  readonly mode = 'xlayer';
  private fees = 0n;
  private chain = {
    id: CHAIN_ID,
    name: 'X Layer',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  private account = privateKeyToAccount((process.env.PK as `0x${string}`) || ('0x' as `0x${string}`));
  private publicClient = createPublicClient({ chain: this.chain, transport: http(RPC) });
  private wallet = createWalletClient({ chain: this.chain, transport: http(RPC), account: this.account });

  // Serialize all writes + manage nonce manually so concurrent tasks are safe.
  private seq: Promise<unknown> = Promise.resolve();
  private nextNonce: number | null = null;

  private async serial<T>(body: () => Promise<T>): Promise<T> {
    const run = this.seq.then(() => body(), () => body());
    this.seq = run.then(() => {}, () => {});
    return run;
  }

  private async next(): Promise<number> {
    // Always reconcile against the chain's pending nonce and take the higher of
    // (chain pending, our local counter). This is self-healing: it closes gaps
    // left by failed txs AND avoids reusing a nonce when agent txs landed outside
    // this counter's knowledge (e.g. a long gap while a user signs in the browser,
    // or the startup faucet tx). Within a burst the local counter still wins, so
    // rapid concurrent writes stay correctly sequenced.
    const chainPending = await this.publicClient.getTransactionCount({
      address: this.account.address,
      blockTag: 'pending',
    });
    this.nextNonce = this.nextNonce === null ? chainPending : Math.max(this.nextNonce, chainPending);
    return this.nextNonce++;
  }

  /**
   * Recover after a failed write. The local counter has been advanced past a
   * nonce that never landed on-chain; left alone, every later tx has a gap and
   * hangs. Reset to null so the next next() re-reads the true pending nonce.
   */
  private resetNonce(): void {
    this.nextNonce = null;
  }

  private async write(abi: any, to: `0x${string}`, fnName: string, args: any[]): Promise<`0x${string}`> {
    return this.serial(async () => {
      const nonce = await this.next();
      try {
        const hash = await this.wallet.writeContract({
          address: to,
          abi,
          functionName: fnName,
          args,
          nonce,
          account: this.account,
          chain: this.chain,
        } as any);
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
      } catch (e) {
        this.resetNonce();
        throw e;
      }
    });
  }

  private async deploy(args: any[]): Promise<{ hash: `0x${string}`; address: `0x${string}` }> {
    return this.serial(async () => {
      const nonce = await this.next();
      try {
        const hash = await this.wallet.deployContract({
          abi: ESCROW.abi,
          bytecode: ESCROW.bytecode,
          args,
          nonce,
          account: this.account,
          chain: this.chain,
        } as any);
        const r = await this.publicClient.waitForTransactionReceipt({ hash });
        return { hash, address: r.contractAddress! };
      } catch (e) {
        this.resetNonce();
        throw e;
      }
    });
  }

  async escrowLock(p: { payee: string; amount: bigint; token?: string; taskId?: string }) {
    const token = tokenAddr(p.token);
    // In this deployment the agent is the funder: it holds the tokens, approves
    // the escrow, and the escrow pulls from it. The contract still enforces that
    // funds can only exit to the payee (on release) or back to the funder (on
    // refund) — the agent key cannot redirect them elsewhere.
    const funder = this.account.address;
    const { address: esc } = await this.deploy([funder, p.payee, token, p.amount, FEE_BPS, TREASURY]);
    await this.write(ERC20_ABI, token, 'approve', [esc, p.amount]);
    const lockHash = await this.write(ESCROW.abi, esc, 'lock', []);
    // Fee is skimmed on release (see escrowRelease), not at lock time — accruing
    // here as well would double-count it in totalFees().
    return { contract: esc, hash: lockHash };
  }

  async escrowRelease(p: { contract: string; amount: bigint; token?: string; taskId?: string }): Promise<SettlementTx> {
    const hash = await this.write(ESCROW.abi, p.contract as `0x${string}`, 'release', []);
    const fee = (p.amount * FEE_BPS) / 10000n;
    this.fees += fee;
    return { hash, from: p.contract, to: 'payee', amount: p.amount, token: p.token ?? 'USDC', fee };
  }

  /**
   * Deploy an escrow whose funder is a CONNECTED USER (not the agent). The agent
   * pays gas to deploy and orchestrate, but the user will approve + lock from
   * their own wallet, and only the user's funds enter escrow. This is the
   * non-custodial, bring-your-own-wallet path. Returns the escrow address and
   * everything the browser needs to sign the approve + lock itself.
   */
  async deployUserEscrow(p: { funder: string; payee: string; amount: bigint; token?: string }): Promise<{
    escrow: `0x${string}`;
    deployHash: `0x${string}`;
    token: `0x${string}`;
    amount: string;
    chainId: number;
  }> {
    const token = tokenAddr(p.token);
    const { address: esc, hash } = await this.deploy([p.funder, p.payee, token, p.amount, FEE_BPS, TREASURY]);
    return { escrow: esc, deployHash: hash, token, amount: p.amount.toString(), chainId: CHAIN_ID };
  }

  /**
   * Release a user-funded escrow after proof. Verifies on-chain that the escrow
   * has actually been funded (balance >= amount) before triggering release, so
   * the agent never calls release on an unfunded/again-released escrow.
   */
  async releaseUserEscrow(p: { contract: string; amount: bigint; token?: string }): Promise<SettlementTx> {
    const token = tokenAddr(p.token);
    const bal = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [p.contract as `0x${string}`],
    } as any)) as bigint;
    if (bal < p.amount) throw new Error(`escrow not funded: holds ${bal}, need ${p.amount}`);
    return this.escrowRelease(p);
  }

  /**
   * Refund a user-funded escrow back to its funder (abort / stuck-funds path).
   * Agent-gated on-chain. Verifies the escrow still holds funds and isn't already
   * released before calling refund(), so a double-refund or empty call reverts early.
   */
  async refundUserEscrow(p: { contract: string; token?: string }): Promise<{ hash: `0x${string}`; refunded: string; funder: string }> {
    const esc = p.contract as `0x${string}`;
    const [released, funder, amount] = (await Promise.all([
      this.publicClient.readContract({ address: esc, abi: ESCROW.abi, functionName: 'released', args: [] } as any),
      this.publicClient.readContract({ address: esc, abi: ESCROW.abi, functionName: 'funder', args: [] } as any),
      this.publicClient.readContract({ address: esc, abi: ESCROW.abi, functionName: 'amount', args: [] } as any),
    ])) as [boolean, string, bigint];
    if (released) throw new Error('escrow already released/refunded');
    const token = tokenAddr(p.token);
    const bal = (await this.publicClient.readContract({
      address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [esc],
    } as any)) as bigint;
    if (bal < amount) throw new Error(`escrow not funded: holds ${bal}`);
    const hash = await this.write(ESCROW.abi, esc, 'refund', []);
    return { hash, refunded: amount.toString(), funder };
  }

  /** Everything the browser needs to build + sign transactions against the escrow. */
  clientConfig() {
    return {
      chainId: CHAIN_ID,
      rpc: RPC,
      token: USDC,
      treasury: TREASURY,
      feeBps: Number(FEE_BPS),
      escrowAbi: ESCROW.abi,
      escrowBytecode: ESCROW.bytecode,
      erc20Abi: ERC20_ABI,
      agent: this.account.address,
    };
  }

  async transfer(p: { to: string; amount: bigint; token?: string; taskId?: string }): Promise<SettlementTx> {
    const token = tokenAddr(p.token);
    const hash = await this.write(ERC20_ABI, token, 'transfer', [p.to, p.amount]);
    const fee = (p.amount * FEE_BPS) / 10000n;
    this.fees += fee;
    return { hash, from: this.account.address, to: p.to, amount: p.amount, token: p.token ?? 'USDC', fee };
  }

  totalFees(): bigint {
    return this.fees;
  }

  /**
   * Demo helper: mint test tokens to the agent (TestUSDC exposes mint()).
   * No-op on mainnet (chain 196) — canonical USDC is not mintable, and minting
   * has no meaning there. Guards against a testnet demo call bricking on mainnet.
   */
  async faucet(amount: bigint): Promise<void> {
    if (CHAIN_ID === 196) return; // X Layer mainnet — no faucet
    await this.write(ERC20_ABI, USDC, 'mint', [this.account.address, amount]);
  }

  /** Record an on-chain attestation. Uses the SAME serialized nonce as other writes. */
  async attest(about: string, proofHash: string): Promise<string> {
    if (ATTESTATION === '0x0000000000000000000000000000000000000000') {
      throw new Error('no XLAYER_ATTESTATION configured');
    }
    const ATTEST_ABI = [
      { type: 'function', name: 'attest', stateMutability: 'nonpayable', inputs: [{ name: 'about', type: 'address' }, { name: 'proofHash', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
    ] as const;
    return this.serial(async () => {
      const nonce = await this.next();
      try {
        const hash = await this.wallet.writeContract({
          address: ATTESTATION,
          abi: ATTEST_ABI,
          functionName: 'attest',
          args: [about as `0x${string}`, proofHash as `0x${string}`],
          nonce,
          account: this.account,
          chain: this.chain,
        } as any);
        await this.publicClient.waitForTransactionReceipt({ hash });
        return hash;
      } catch (e) {
        this.resetNonce();
        throw e;
      }
    });
  }
}
