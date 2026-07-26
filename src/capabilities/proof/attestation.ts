import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ProofAdapter, ProofEvidence, ProofResult, ProofObligation } from '../../kernel/proof';

/**
 * On-chain attestation. Records fulfillment as a verifiable on-chain attestation
 * on X Layer (via the Attestation contract). This is the strongest proof: it
 * is publicly auditable and survives forever. Registered only when
 * XLAYER_ATTESTATION (the deployed contract) is configured.
 */
export class AttestationAdapter implements ProofAdapter {
  type = 'attestation';
  description = 'Record fulfillment as a verifiable on-chain attestation on X Layer (real proof).';

  private client: any;
  private wallet: any;
  private account: any;
  private addr: `0x${string}`;
  /** Injected by the verify capability so the attestation write shares the
   *  settlement's serialized nonce manager (no concurrent-nonce races). */
  attestFn?: (about: string, proofHash: string) => Promise<string>;

  constructor() {
    const RPC = process.env.XLAYER_RPC || 'https://rpc.xlayer.tech';
    const CHAIN = Number(process.env.XLAYER_CHAIN_ID || 196);
    this.addr = (process.env.XLAYER_ATTESTATION || '0x0000000000000000000000000000000000000000') as `0x${string}`;
    const chain = {
      id: CHAIN,
      name: 'X Layer',
      nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
      rpcUrls: { default: { http: [RPC] } },
    };
    this.client = createPublicClient({ chain, transport: http(RPC) });
  }

  /** Lazily derive the signer — booting without a PK must not crash. */
  private getAccount() {
    if (!process.env.PK) throw new Error('no PK configured for attestation');
    if (!this.account) this.account = privateKeyToAccount(process.env.PK as `0x${string}`);
    return this.account;
  }

  async verify(o: ProofObligation, _e: ProofEvidence): Promise<ProofResult> {
    const account = this.getAccount();
    const about = (o.payee || account.address) as `0x${string}`;
    const proofHash = keccak256(toHex(o.summary));
    let hash: string;
    if (this.attestFn) {
      // Product path: shares the settlement's serialized nonce manager.
      hash = await this.attestFn(about, proofHash);
    } else {
      if (!this.addr || this.addr === '0x0000000000000000000000000000000000000000') {
        return { ok: false, confidence: 0, detail: 'no XLAYER_ATTESTATION configured' };
      }
      const artifact = JSON.parse(
        readFileSync(new URL('../../../artifacts/Attestation.json', import.meta.url)) as any,
      );
      const wallet = createWalletClient({ chain: this.client.chain, transport: http((this.client.chain.rpcUrls.default.http as string[])[0]), account });
      hash = await wallet.writeContract({
        address: this.addr,
        abi: artifact.abi,
        functionName: 'attest',
        args: [about, proofHash],
        account,
        chain: this.client.chain,
      } as any);
      await this.client.waitForTransactionReceipt({ hash });
    }
    return { ok: true, confidence: 0.99, detail: 'attestation recorded on-chain', onchain: hash };
  }
}
