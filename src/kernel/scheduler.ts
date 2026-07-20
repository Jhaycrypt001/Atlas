import { Ledger } from './ledger';
import { Safety } from './safety';
import { Settlement } from './settlement';
import { Planner } from './planner';
import { Capability, RunContext, Task } from './types';

function safeString(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
}

/**
 * Concurrent job scheduler. Runs many tasks in parallel up to a concurrency
 * limit, with per-task isolation and idempotency. The planner proposes the
 * plan; the kernel validates (safety gate) before any value moves.
 */
export class Scheduler {
  private active = 0;
  private queue: Array<() => Promise<void>> = [];

  constructor(
    private ledger: Ledger,
    private safety: Safety,
    private settlement: Settlement,
    private planner: Planner,
    private caps: Map<string, Capability>,
    private concurrency = 4,
  ) {}

  submit(intent: string, owner: string = 'server'): string {
    const task = this.ledger.create(intent, 'pending', {}, ['planning'], owner);
    this.queue.push(() => this.execute(task.id, intent));
    this.pump();
    return task.id;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      job().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async execute(taskId: string, intent: string): Promise<void> {
    this.ledger.update(taskId, { status: 'running' });
    const plan = await this.planner.plan(intent);
    const cap = this.caps.get(plan.capability);
    if (!cap) {
      this.ledger.update(taskId, {
        status: 'failed',
        result: { ok: false, summary: `no capability: ${plan.capability}` },
      });
      return;
    }
    this.ledger.update(taskId, { capability: plan.capability, input: plan.input, plan: [plan.capability] });

    const decision = await this.safety.gate(cap.risk, safeString(plan.input));
    if (!decision.approved) {
      this.ledger.update(taskId, { status: 'failed', result: { ok: false, summary: decision.reason } });
      return;
    }

    const ctx: RunContext = {
      taskId,
      ledger: this.ledger,
      settlement: this.settlement,
      safety: this.safety,
      log: (m: string) => this.ledger.update(taskId, { plan: [m] }),
    };

    try {
      const result = await cap.run(ctx, plan.input);
      if (result.fee) this.ledger.accrueFee(taskId, result.fee);
      this.ledger.update(taskId, { status: 'done', result });
    } catch (e: any) {
      this.ledger.update(taskId, {
        status: 'failed',
        result: { ok: false, summary: String(e?.message ?? e) },
      });
    }
  }
}
