import { Capability } from './types';

export interface Plan {
  capability: string;
  input: Record<string, unknown>;
}

/**
 * Coerce any planner-produced amount into USDC base units (bigint-safe string).
 * LLMs sometimes emit decimals ("200.000000" or "200.5") despite instructions;
 * integers are already base units and pass through untouched.
 */
/**
 * Parse a HUMAN whole/decimal USDC string ("6", "2.5") to base units (6dp).
 * For amounts a person types directly (e.g. a split-total field), where a bare
 * "6" means 6 USDC — NOT 6 base units. Returns 0n on garbage.
 */
export function usdcToBase(v: unknown): bigint {
  const s = String(v ?? '').trim().replace(/[,_\s]/g, '');
  const m = s.match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return 0n;
  const frac = (m[2] || '').padEnd(6, '0');
  return BigInt(m[1]) * 1000000n + BigInt(frac || '0');
}

/**
 * Format USDC base units (6dp) as a human amount for display/summaries.
 * e.g. 5000000n -> "5", 25000n -> "0.025". Inverse of normalizeAmount's scaling.
 */
export function formatUsdc(v: unknown): string {
  let n: bigint;
  try { n = BigInt(String(v ?? '0')); } catch { return '0'; }
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = n / 1000000n;
  const frac = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : `${whole}`);
}

export function normalizeAmount(v: unknown): string {
  const raw = String(v ?? '0').trim();
  // Grouping separators (commas/underscores/spaces between digits) signal a
  // human-written whole amount like "1,000" — 1000 USDC, i.e. 1000 * 1e6 base
  // units — NOT 1000 base units. Detect them before stripping so we don't
  // confuse "1,000" with the bare integer "1000".
  const grouped = /\d[,_\s]\d/.test(raw);
  const s = raw.replace(/[,_\s]/g, '');
  if (/^\d+$/.test(s)) {
    return grouped ? (BigInt(s) * 1000000n).toString() : s; // grouped => scale, else already base units
  }
  const m = s.match(/^(\d+)\.(\d*)$/);
  if (m) {
    const frac = (m[2] + '000000').slice(0, 6); // pad/truncate to 6dp
    return (BigInt(m[1]) * 1000000n + BigInt(frac || '0')).toString();
  }
  return '0';
}

/**
 * Routes natural-language intent to a capability + structured input.
 * Rule-based by default (deterministic, offline). If an LLM fn is supplied
 * (an LLM), it is tried first, with the rule-based planner as fallback.
 */
export class Planner {
  constructor(
    private caps: Capability[],
    private llm?: (text: string) => Promise<Plan | null>,
  ) {}

  async plan(intent: string): Promise<Plan> {
    if (this.llm) {
      const p = await this.llm(intent);
      if (p && this.caps.some((c) => c.name === p.capability)) return this.sanitize(p);
    }
    return this.ruleBased(intent);
  }

  /** Normalize value fields so capabilities can BigInt() them safely. */
  private sanitize(p: Plan): Plan {
    const input = { ...p.input };
    for (const k of ['amount', 'total']) {
      if (k in input) input[k] = normalizeAmount(input[k]);
    }
    return { capability: p.capability, input };
  }

  /** Deterministic extraction for the demo + offline operation. */
  private ruleBased(intent: string): Plan {
    const lower = intent.toLowerCase();
    // Strip 0x addresses so their digits aren't misread as the amount.
    const cleaned = intent.replace(/0x[a-fA-F0-9]{40}/g, '');
    const amountMatch = cleaned.match(/\$?(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? BigInt(Math.round(parseFloat(amountMatch[1]) * 1e6)) : 0n; // USDC 6dp
    const addrMatch = intent.match(/0x[a-fA-F0-9]{40}/);
    const payee = addrMatch ? addrMatch[0] : '0xPayeeDemo0000000000000000000000000000';

    if (lower.includes('split') || lower.includes('trip') || lower.includes('group')) {
      return {
        capability: 'split',
        input: { members: ['alice', 'bob', 'carol'], total: amount || 300000000n, token: 'USDC' },
      };
    }
    if (lower.includes('invoice') || lower.includes('get paid') || lower.includes('bill')) {
      return { capability: 'getPaid', input: { client: payee, amount, token: 'USDC', reason: intent.slice(0, 40) } };
    }
    if (lower.includes('verify') || lower.includes('deliver') || lower.includes('proof')) {
      const proofType = lower.includes('attest') ? 'attestation' : 'receipt';
      return { capability: 'verify', input: { obligation: intent.slice(0, 40), payee, amount, proofType } };
    }
    // default: pay
    return { capability: 'pay', input: { payee, amount: amount || 50000000n, token: 'USDC', reason: intent.slice(0, 40) } };
  }
}
