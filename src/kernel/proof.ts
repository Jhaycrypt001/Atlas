/**
 * Proof Adapter Registry — the moat.
 *
 * "verify" is just one proof adapter among many. Each adapter knows how to
 * confirm that an obligation was actually fulfilled: a receipt (LLM-checked),
 * a signed webhook (HMAC), or an on-chain attestation. New proof types = new
 * plugins; the core never changes. This is what makes Atlas "verifiable", not
 * a chatbot that trusts a prompt.
 */
import { ReceiptOcrAdapter } from '../capabilities/proof/receiptOcr';
import { WebhookAdapter } from '../capabilities/proof/webhook';
import { AttestationAdapter } from '../capabilities/proof/attestation';

export interface ProofObligation {
  summary: string;
  amount?: bigint;
  payee?: string;
}

export interface ProofEvidence {
  type: string;
  payload: any;
}

export interface ProofResult {
  ok: boolean;
  confidence: number; // 0..1
  detail: string;
  onchain?: string; // tx hash if proof was recorded on-chain
}

export interface ProofAdapter {
  type: string;
  description: string;
  verify(obligation: ProofObligation, evidence: ProofEvidence): Promise<ProofResult>;
}

export class ProofRegistry {
  private m = new Map<string, ProofAdapter>();
  register(a: ProofAdapter): void {
    this.m.set(a.type, a);
  }
  get(type: string): ProofAdapter | undefined {
    return this.m.get(type);
  }
  list(): ProofAdapter[] {
    return [...this.m.values()];
  }
}

/** Build the default registry. Attestation is only registered when configured. */
export function defaultRegistry(): ProofRegistry {
  const r = new ProofRegistry();
  r.register(new ReceiptOcrAdapter());
  r.register(new WebhookAdapter());
  if (process.env.XLAYER_ATTESTATION) r.register(new AttestationAdapter());
  return r;
}

// Constructed once at module load; importing `verify` registers the adapters.
export const proofRegistry: ProofRegistry = defaultRegistry();
