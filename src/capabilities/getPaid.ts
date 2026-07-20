import { Capability, CapabilityResult, RunContext } from '../kernel/types';
import { formatUsdc } from '../kernel/planner';

/** Generate an invoice and lock client funds in escrow until delivery verified. */
export const GetPaidCapability: Capability = {
  name: 'getPaid',
  description: 'Issue an invoice and lock client funds in escrow until delivery is verified.',
  risk: 'value',
  examples: ['Invoice Acme 500 USDC for consulting', 'Bill client 0x.. 1200 USDC'],
  async run(ctx: RunContext, input): Promise<CapabilityResult> {
    const client = String(input.client);
    const amount = BigInt(input.amount as any);
    const token = String(input.token ?? 'USDC');
    ctx.log(`creating invoice for ${client}`);
    const lock = await ctx.settlement.escrowLock({ payee: client, amount, token, taskId: ctx.taskId });
    ctx.log(`invoice escrow ${lock.contract} locked; awaiting delivery proof`);
    return {
      ok: true,
      summary: `Invoice ${formatUsdc(amount)} ${token} issued to ${client}; escrow ${lock.contract}`,
      txHash: lock.hash,
      fee: lock.hash ? 0n : 0n,
    };
  },
};
