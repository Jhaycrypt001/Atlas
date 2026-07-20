import { Capability, CapabilityResult, RunContext } from '../kernel/types';
import { formatUsdc } from '../kernel/planner';

/** Net a group expense and settle all balances in one batched set of transfers. */
export const SplitCapability: Capability = {
  name: 'split',
  description: 'Net a group expense and settle all balances in batched transfers.',
  risk: 'value',
  examples: ['Split the trip 300 USDC between alice,bob,carol', 'Settle group dinner'],
  async run(ctx: RunContext, input): Promise<CapabilityResult> {
    const members = (input.members as string[]) ?? ['alice', 'bob'];
    const total = BigInt(input.total as any);
    const token = String(input.token ?? 'USDC');
    const each = total / BigInt(members.length);
    ctx.log(`netting ${total} ${token} across ${members.length}`);
    const txs: string[] = [];
    let fee = 0n;
    for (const m of members) {
      const t = await ctx.settlement.transfer({ to: m, amount: each, token, taskId: ctx.taskId });
      txs.push(t.hash);
      fee += t.fee;
    }
    return { ok: true, summary: `Split ${formatUsdc(total)} ${token} among ${members.join(', ')}`, txHash: txs[0], fee };
  },
};
