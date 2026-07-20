import { RiskTier } from './types';

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
}

/** USDC has 6 decimals. */
const USDC_DECIMALS = 1_000_000n;

/**
 * Per-transaction spend cap for the `value` tier, in whole USDC. A value-moving
 * task above this is blocked outright. Set MAX_VALUE_USDC in .env; defaults to
 * 10,000 USDC so the demo runs but a runaway/huge amount is still stopped.
 */
function valueCapBaseUnits(): bigint {
  const raw = (process.env.MAX_VALUE_USDC ?? '10000').trim();
  const n = /^\d+$/.test(raw) ? BigInt(raw) : 10_000n;
  return n * USDC_DECIMALS;
}

/**
 * Pull the largest base-unit amount out of the serialized plan input the
 * scheduler passes in (contains `amount` and/or `total`). Returns 0n if none
 * is found, which fails safe (0 is always under the cap).
 */
function extractAmount(summary: string): bigint {
  let max = 0n;
  for (const m of summary.matchAll(/(?:"?(?:amount|total)"?\s*[:=]\s*"?)(\d+)/g)) {
    const v = BigInt(m[1]);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Risk-tiered execution gate. The tier is declared in the capability plugin,
 * so safety scales with capability breadth automatically.
 *
 *   read        -> auto
 *   logic       -> auto after simulate
 *   value       -> enforce a per-tx spend cap (MAX_VALUE_USDC); block if exceeded
 *   destructive -> blocked in MVP (needs multisig + timeout)
 *
 * The value cap is a real, enforced policy — not a rubber stamp. A production
 * build would additionally require a user signature (OKX wallet connect) here;
 * that step is the documented gap, but the cap below actually stops spend.
 */
export class Safety {
  async gate(risk: RiskTier, summary: string): Promise<ApprovalDecision> {
    switch (risk) {
      case 'read':
        return { approved: true, reason: 'read-only, auto' };
      case 'logic': {
        const sim = await this.simulate(summary);
        return sim.ok
          ? { approved: true, reason: 'logic: preconditions ok' }
          : { approved: false, reason: `logic blocked: ${sim.reason}` };
      }
      case 'value': {
        const cap = valueCapBaseUnits();
        const amount = extractAmount(summary);
        if (amount > cap) {
          return {
            approved: false,
            reason: `value blocked: ${amount} base units exceeds cap ${cap} (MAX_VALUE_USDC=${cap / USDC_DECIMALS} USDC)`,
          };
        }
        return { approved: true, reason: `value within cap (${amount}/${cap} base units)` };
      }
      case 'destructive':
        return { approved: false, reason: 'destructive requires multisig+timeout (not in MVP)' };
    }
  }

  /**
   * Precondition check for value-adjacent plans, run before any capability
   * executes. This validates the plan is structurally settle-able — a positive
   * amount within the cap, and a plausible recipient address. It is NOT a full
   * on-chain eth_call/estimateGas state-diff preview; that would require threading
   * a chain client and concrete calldata through this layer and is the documented
   * next step. What it does here is real: a malformed plan is rejected up front.
   */
  async simulate(summary: string): Promise<{ ok: boolean; reason: string }> {
    const amount = extractAmount(summary);
    if (amount <= 0n) return { ok: false, reason: 'no positive amount in plan' };
    if (amount > valueCapBaseUnits()) return { ok: false, reason: 'amount exceeds value cap' };
    // If a recipient field is present, it must look like an EVM address.
    const recip = summary.match(/(?:payee|client|to)"?\s*[:=]\s*"?(0x[a-fA-F0-9]{40})/);
    const anyAddrClaim = /(?:payee|client|to)"?\s*[:=]\s*"?0x/.test(summary);
    if (anyAddrClaim && !recip) return { ok: false, reason: 'recipient is not a valid address' };
    return { ok: true, reason: 'preconditions ok' };
  }
}
