import { Capability, CapabilityResult, RunContext } from '../kernel/types';
import { proofRegistry } from '../kernel/proof';
import { formatUsdc } from '../kernel/planner';

/**
 * Verify fulfillment (via a Proof Adapter) then release escrowed value.
 * This is the proof-adapter entry point — the moat. The agent does NOT trust
 * a prompt; it requires a verifiable proof (receipt / webhook / attestation)
 * before any value moves.
 */
export const VerifyCapability: Capability = {
  name: 'verify',
  description: 'Verify fulfillment via a proof adapter (receipt / webhook / on-chain attestation), then release escrowed value.',
  risk: 'logic',
  examples: ['Verify receipt then release 200 USDC to bob', 'Confirm shipment webhook, pay supplier'],
  async run(ctx: RunContext, input): Promise<CapabilityResult> {
    const payee = String(input.payee);
    const amount = BigInt(input.amount as any);
    const token = String(input.token ?? 'USDC');
    const proofType = String(input.proofType ?? 'receipt');

    // Evidence MUST be supplied independently of the obligation. Defaulting the
    // proof payload to the obligation text (as before) let a caller "verify" an
    // obligation against itself — a trivial pass that released funds with no real
    // proof (audit C2). Require distinct, non-empty evidence.
    const evidence = input.evidence as any;
    const payload = evidence?.payload;
    const hasEvidence = payload != null && String(payload).trim().length > 0
      && String(payload).trim() !== String(input.obligation ?? '').trim();
    if (!hasEvidence) {
      return { ok: false, summary: 'verify: real proof evidence required (receipt/webhook/attestation), distinct from the obligation' };
    }

    ctx.log(`verifying via ${proofType}`);
    const adapter = proofRegistry.get(proofType);
    if (!adapter) return { ok: false, summary: `no proof adapter: ${proofType}` };

    // Route on-chain attestation through the settlement's nonce-safe writer.
    if (proofType === 'attestation' && ctx.settlement.attest) {
      (adapter as any).attestFn = (about: string, h: string) => ctx.settlement.attest!(about, h);
    }

    const res = await adapter.verify(
      { summary: String(input.obligation ?? ''), amount, payee },
      evidence,
    );
    if (!res.ok) return { ok: false, summary: `proof failed: ${res.detail}` };

    const lock = await ctx.settlement.escrowLock({ payee, amount, token, taskId: ctx.taskId });
    const rel = await ctx.settlement.escrowRelease({ contract: lock.contract, amount, token, taskId: ctx.taskId });
    const proofNote = res.onchain ? ` (on-chain proof ${res.onchain})` : '';
    return {
      ok: true,
      summary: `Verified [${proofType}: ${res.detail}] + released ${formatUsdc(amount)} ${token} to ${payee}${proofNote}`,
      txHash: rel.hash,
      fee: rel.fee,
    };
  },
};
