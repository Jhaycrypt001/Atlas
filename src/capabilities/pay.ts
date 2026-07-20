import { Capability, CapabilityResult, RunContext } from '../kernel/types';
import { formatUsdc } from '../kernel/planner';

/** Settle an obligation: lock in non-custodial escrow, release on verification. */
export const PayCapability: Capability = {
  name: 'pay',
  description: 'Settle an obligation: lock funds in non-custodial escrow, release on verification.',
  risk: 'value',
  examples: ['Pay Bob 200 USDC for the logo', 'Settle invoice to 0xabc... 500 USDC'],
  async run(ctx: RunContext, input): Promise<CapabilityResult> {
    const payee = String(input.payee);
    const amount = BigInt(input.amount as any);
    const token = String(input.token ?? 'USDC');
    ctx.log(`locking ${amount} ${token} for ${payee}`);
    const lock = await ctx.settlement.escrowLock({ payee, amount, token, taskId: ctx.taskId });
    ctx.log(`escrow ${lock.contract} deployed`);
    const release = await ctx.settlement.escrowRelease({ contract: lock.contract, amount, token, taskId: ctx.taskId });
    return { ok: true, summary: `Settled ${formatUsdc(amount)} ${token} to ${payee}`, txHash: release.hash, fee: release.fee };
  },
};
