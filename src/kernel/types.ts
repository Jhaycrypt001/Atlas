// Core domain types for the Atlas agent kernel.

import { Settlement } from './settlement';

export type RiskTier = 'read' | 'logic' | 'value' | 'destructive';

export interface CapabilityResult {
  ok: boolean;
  summary: string;
  txHash?: string;
  fee?: bigint;
  data?: unknown;
}

export interface RunContext {
  taskId: string;
  ledger: LedgerLike;
  settlement: Settlement;
  safety: SafetyLike;
  log: (msg: string) => void;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'failed';

export interface Task {
  id: string;
  intent: string;
  capability: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  plan: string[];
  result?: CapabilityResult;
  createdAt: number;
  updatedAt: number;
  feesAccrued: bigint;
  /**
   * Who owns this task for dashboard visibility. A lowercased wallet address for
   * connected-wallet (user-funded) tasks; 'server' for demo/agent-funded tasks.
   * The live-ledger SSE feed filters on this so a visitor sees only their own.
   */
  owner: string;
}

export interface Capability {
  name: string;
  description: string;
  risk: RiskTier;
  examples: string[];
  run(ctx: RunContext, input: Record<string, unknown>): Promise<CapabilityResult>;
}

//Structural interfaces to avoid import cycles in capability code.
export interface LedgerLike {
  update(id: string, patch: Partial<Task>): void;
  accrueFee(id: string, fee: bigint): void;
}

export interface SafetyLike {
  gate(risk: RiskTier, summary: string): Promise<{ approved: boolean; reason: string }>;
}
