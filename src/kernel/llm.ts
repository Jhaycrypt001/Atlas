import { Plan } from './planner';

/**
 * Real LLM planner. Extracts structured intent from free text.
 * Lazy-loaded + falls back to the rule-based planner when no API key is set.
 * Amounts are returned as strings of smallest units (e.g. "200000000" = 200 USDC).
 */
export async function llmPlanner(intent: string): Promise<Plan | null> {
  const key = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });

  const system = [
    'You are the planner for Atlas, a concurrent on-chain operations agent on X Layer.',
    'Map a user request to exactly one capability and structured input.',
    'Capabilities:',
    '  pay     -> {payee:address, amount:string(USDC 6dp), token:"USDC", reason:string}',
    '  getPaid -> {client:address, amount:string(USDC 6dp), token:"USDC", reason:string}',
    '  split   -> {members:string[], total:string(USDC 6dp), token:"USDC"}',
    '  verify  -> {obligation:string, payee:address, amount:string(USDC 6dp), token:"USDC"}',
    'Amounts are strings of INTEGER base units at 6 decimals — 200 USDC = "200000000". Never emit a decimal point.',
    'Respond with ONLY strict JSON: {"capability":string,"input":{...}}. No prose.',
  ].join('\n');

  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: intent }],
    });
    // Walk the content blocks for the first text block rather than assuming [0].
    const text = r.content.find((b) => b.type === 'text')?.text ?? '';
    const json = extractJson(text);
    if (!json) {
      console.warn(`[llmPlanner] no JSON object in model output; falling back. Raw: ${text.slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.capability === 'string' && parsed.input) return parsed as Plan;
    console.warn(`[llmPlanner] JSON missing capability/input; falling back. Parsed: ${json.slice(0, 200)}`);
    return null;
  } catch (e) {
    console.warn(`[llmPlanner] error, falling back to rule-based planner: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Pull a JSON object out of a model response that may wrap it in prose or a
 * ```json fence. Returns the JSON substring, or null if none is present.
 */
function extractJson(text: string): string | null {
  const t = text.trim();
  // Strip a ```json ... ``` or ``` ... ``` fence if present.
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : t).trim();
  if (body.startsWith('{')) return body;
  // Otherwise grab the first {...} span (handles leading/trailing prose).
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start !== -1 && end > start ? body.slice(start, end + 1) : null;
}
