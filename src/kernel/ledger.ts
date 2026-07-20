import { Task, TaskStatus } from './types';

type Listener = (task: Task) => void;

/**
 * The unified, live ledger. One view of every concurrent task, its status,
 * tx hashes and accrued fees. This is both the demo wow-factor and the
 * cleanest Revenue-Rocket evidence (fees accrue on-chain, visibly).
 */
export class Ledger {
  private tasks = new Map<string, Task>();
  private listeners = new Set<Listener>();
  private seq = 0;

  create(
    intent: string,
    capability: string,
    input: Record<string, unknown>,
    plan: string[],
    owner: string = 'server',
  ): Task {
    const id = `task_${++this.seq}`;
    const now = Date.now();
    const task: Task = {
      id,
      intent,
      capability,
      input,
      status: 'queued',
      plan,
      createdAt: now,
      updatedAt: now,
      feesAccrued: 0n,
      owner: owner.toLowerCase(),
    };
    this.tasks.set(id, task);
    this.evict();
    this.emit(task);
    return task;
  }

  /** Cap in-memory tasks so the ledger can't grow without bound (audit M2).
   *  Evicts the oldest by insertion order beyond LEDGER_MAX (default 500). */
  private evict(): void {
    const max = Number(process.env.LEDGER_MAX || 500);
    while (this.tasks.size > max) {
      const oldest = this.tasks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  update(id: string, patch: Partial<Task>): void {
    const t = this.tasks.get(id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.emit(t);
  }

  accrueFee(id: string, fee: bigint): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.feesAccrued += fee;
    this.emit(t);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  on(fn: Listener): void {
    this.listeners.add(fn);
  }

  private emit(t: Task): void {
    this.listeners.forEach((l) => l(t));
  }
}
