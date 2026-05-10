import { z } from "zod";

export const JobConfigSchema = z.object({
  prompt: z.string(),
  /** Exact provider model id (e.g. CLōD: `DeepSeek V3`); omit to use DEFAULT_AGENT_MODEL / CLOD_DEFAULT_MODEL. */
  model: z.string().min(1).optional(),
  depends_on: z.array(z.string()).optional().default([]),
  gate: z.enum(["auto", "human"]).default("auto"),
  context_budget: z.number().int().positive().default(2000),
  tools: z.array(z.string()).optional().default([]),
  /** Max assistant rounds when tools are enabled (each round may include multiple tool calls). */
  tool_rounds_max: z.number().int().min(1).max(64).default(12),
  /**
   * If `halt`, a failed job stops the run. If `retry`, dependent jobs still run and receive failure context;
   * it does **not** by itself re-invoke the failed job — use `max_retries` for extra attempts on the same job.
   */
  on_failure: z.enum(["halt", "retry"]).default("halt"),
  /** Extra attempts after the first failure for this job only (default 0 = one attempt). */
  max_retries: z.number().int().min(0).max(5).default(0),
  budget_usd: z.number().positive().optional(),
});

export const WorkflowConfigSchema = z.object({
  name: z.string(),
  jobs: z.record(z.string(), JobConfigSchema),
});

export type JobConfig = z.infer<typeof JobConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

export type JobStatus =
  | "pending" | "running" | "gate_pending"
  | "gate_approved" | "awaiting_funding" | "completed" | "failed" | "skipped";

export type RunStatus = "running" | "gate_pending" | "awaiting_funding" | "completed" | "failed";

export interface JobState {
  jobId: string; status: JobStatus;
  startedAt?: string; completedAt?: string;
  output?: string; tokensUsed?: number; costUsd?: number;
  retryCount: number; error?: string;
  checkoutUrl?: string;
}

export interface SerializedDAGNode {
  jobId: string;
  dependencies: string[];
  dependents: string[];
}

export interface SerializedDAG {
  nodes: SerializedDAGNode[];
  executionWaves: string[][];
}

export interface RunState {
  runId: string;
  workflowName: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  jobs: Record<string, JobState>;
  dag?: SerializedDAG;
}

export type EventType =
  | "RUN_STARTED" | "JOB_STARTED" | "JOB_COMPLETED" | "JOB_FAILED"
  | "JOB_RETRY_WARNING" | "GATE_PENDING" | "GATE_APPROVED" | "GATE_REJECTED"
  | "BUDGET_EXCEEDED" | "BUDGET_FUNDED" | "JOB_RESUMED"
  | "RUN_COMPLETED" | "RUN_FAILED";

export interface RunEvent {
  eventId: string; runId: string; jobId?: string;
  type: EventType; timestamp: string;
  version: number;
  payload?: Record<string, unknown>;
}

export interface GateRequest {
  runId: string; jobId: string; proposedOutput: string; context: string;
}
export interface GateDecision {
  approved: boolean; editedOutput?: string; reason?: string;
}
export type UpstreamKind = "completed" | "failed";

export interface AgentRunOptions {
  jobId: string;
  jobConfig: JobConfig;
  contextInput: string;
  /** Populated on retries: errors from earlier attempts of this same job (passed into the model prompt). */
  priorAttemptErrors?: string[];
  /** Per dependency: successful output vs failure transcript from event log. */
  upstreamKind?: Record<string, UpstreamKind>;
}
export interface AgentRunResult {
  output: string; tokensUsed: number; costUsd: number;
}

export interface BudgetExceededInfo {
  runId: string;
  jobId: string;
  spentUsd: number;
  limitUsd: number;
  checkoutUrl: string;
  intentId: string;
}
