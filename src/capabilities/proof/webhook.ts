import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProofAdapter, ProofEvidence, ProofResult, ProofObligation } from '../../kernel/proof';

/**
 * Signed webhook verification (HMAC-SHA256). The agent trusts a real external
 * signal — e.g. a "order shipped" callback from Shopify/Stripe — only if the
 * signature is valid. This is how Atlas settles on actual fulfillment events,
 * not on a prompt saying "it shipped".
 */
export class WebhookAdapter implements ProofAdapter {
  type = 'webhook';
  description = 'Verify a signed webhook callback (HMAC-SHA256) proves an event occurred (e.g. order shipped).';

  async verify(_o: ProofObligation, e: ProofEvidence): Promise<ProofResult> {
    const { body, signature, secret } = e.payload || {};
    if (!body || !signature || !secret) {
      return { ok: false, confidence: 0, detail: 'missing body/signature/secret' };
    }
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const sig = String(signature).startsWith('sha256=') ? String(signature).slice(7) : String(signature);
    const ok = safeEqual(expected, sig);
    return { ok, confidence: ok ? 0.95 : 0, detail: ok ? 'webhook signature valid' : 'invalid signature' };
  }
}

function safeEqual(a: string, b: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
