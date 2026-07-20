/**
 * Settlement layer. Every value-moving capability routes through here.
 * The agent NEVER custodies funds: XLayerSettlement (see xlayer.ts) deploys
 * a non-custodial Escrow contract per agreement and settles on X Layer.
 *
 * A basis-point fee is skimmed on every action -> on-chain, provable revenue.
 */

export const FEE_BPS = 50n; // 0.5%

export interface SettlementTx {
  hash: string;
  from: string;
  to: string;
  amount: bigint;
  token: string;
  fee: bigint;
}

export interface Settlement {
  readonly mode: string;
  transfer(p: { to: string; amount: bigint; token?: string; taskId?: string }): Promise<SettlementTx>;
  escrowLock(p: { payee: string; amount: bigint; token?: string; taskId?: string }): Promise<{ contract: string; hash: string }>;
  escrowRelease(p: { contract: string; amount: bigint; token?: string; taskId?: string }): Promise<SettlementTx>;
  totalFees(): bigint;
  /** Mint test tokens to the agent so repeatable demos never drain the balance. */
  faucet?(amount: bigint): Promise<void>;
  /** Record an on-chain attestation. Shares the serialized nonce. */
  attest?(about: string, proofHash: string): Promise<string>;

  // ---- Bring-your-own-wallet (non-custodial) path ----
  /** Deploy an escrow funded by a connected user; user signs approve+lock themselves. */
  deployUserEscrow?(p: { funder: string; payee: string; amount: bigint; token?: string }): Promise<{
    escrow: string;
    deployHash: string;
    token: string;
    amount: string;
    chainId: number;
  }>;
  /** Release a user-funded escrow after verifying it is actually funded on-chain. */
  releaseUserEscrow?(p: { contract: string; amount: bigint; token?: string }): Promise<SettlementTx>;
  /** Refund a user-funded escrow back to its funder (abort / stuck-funds recovery). */
  refundUserEscrow?(p: { contract: string; token?: string }): Promise<{ hash: string; refunded: string; funder: string }>;
  /** Config the browser needs to build + sign escrow transactions. */
  clientConfig?(): {
    chainId: number;
    rpc: string;
    token: string;
    treasury: string;
    feeBps: number;
    escrowAbi: unknown;
    escrowBytecode: string;
    erc20Abi: unknown;
    agent: string;
  };
}
