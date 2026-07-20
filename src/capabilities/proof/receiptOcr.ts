import { ProofAdapter, ProofEvidence, ProofResult, ProofObligation } from '../../kernel/proof';

/**
 * Receipt / invoice verification via LLM. Extracts whether the receipt matches
 * the obligation (payee, amount, purpose) and returns a confidence score.
 * Falls back to a naive rule check only when no API key is present (never the
 * product path — the product always uses the LLM).
 */
export class ReceiptOcrAdapter implements ProofAdapter {
  type = 'receipt';
  description = 'Verify a receipt/invoice (text or JSON) satisfies the obligation via LLM extraction.';

  async verify(o: ProofObligation, e: ProofEvidence): Promise<ProofResult> {
    const text = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload);
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      const ok = text.toLowerCase().includes((o.payee || '').toLowerCase()) || /\d/.test(text);
      return { ok, confidence: ok ? 0.5 : 0.1, detail: 'fallback rule-based (no LLM key)' };
    }
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const sys =
      'You verify a receipt satisfies an obligation. Respond ONLY with strict JSON: ' +
      '{"ok":boolean,"confidence":number(0..1),"detail":string}.';
    const r = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system: sys,
      messages: [{ role: 'user', content: `Obligation: ${o.summary}\nReceipt:\n${text}` }],
    });
    // Walk content blocks for the first text block rather than assuming [0].
    const t = r.content.find((b) => b.type === 'text')?.text ?? '';
    try {
      const p = JSON.parse(t.trim());
      return { ok: !!p.ok, confidence: Number(p.confidence) || 0.5, detail: p.detail || '' };
    } catch {
      return { ok: false, confidence: 0, detail: 'LLM parse error' };
    }
  }
}
