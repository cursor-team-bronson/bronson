import { z } from "zod";

export const JobConfigSchema = z.object({
  prompt: z.string(),
  model: z.string().default("deepseek-v3"),
  depends_on: z.array(z.string()).optional().default([]),
  gate: z.enum(["auto", "human"]).default("auto"),
  context_budget: z.number().int().positive().default(2000),
  tools: z.array(z.string()).optional().default([]),
  on_failure: z.enum(["halt", "retry"]).default("halt"),
  max_retries: z.number().int().min(0).max(5).default(0),
});

export const WorkflowConfigSchema = z.object({
  name: z.string(),
  jobs: z.record(z.string(), JobConfigSchema),
});

export type JobConfig = z.infer<typeof JobConfigSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

export type JobStatus =
  | "pending" | "running" | "gate_pending"
  | "gate_approved" | "completed" | "failed" | "skipped";

export type RunStatus = "running" | "gate_pending" | "completed" | "failed";

export interface JobState {
  jobId: string; status: JobStatus;
  startedAt?: string; completedAt?: string;
  output?: string; tokensUsed?: number; costUsd?: number;
  retryCount: number; error?: string;
}

export interface RunState {
  runId: string; workflowName: string; status: RunStatus;
  createdAt: string; completedAt?: string;
  jobs: Record<string, JobState>;
}

export type EventType =
  | "RUN_STARTED" | "JOB_STARTED" | "JOB_COMPLETED" | "JOB_FAILED"
  | "GATE_PENDING" | "GATE_APPROVED" | "GATE_REJECTED"
  | "RUN_COMPLETED" | "RUN_FAILED";

export interface RunEvent {
  eventId: string; runId: string; jobId?: string;
  type: EventType; timestamp: string;
  /** Monotonic per-run sequence for ordering and optimistic concurrency. */
  version: number;
  payload?: Record<string, unknown>;
}

export interface GateRequest {
  runId: string; jobId: string; proposedOutput: string; context: string;
}
export interface GateDecision {
  approved: boolean; editedOutput?: string; reason?: string;
}
export interface AgentRunOptions {
  jobId: string; jobConfig: JobConfig; contextInput: string;
}
export interface AgentRunResult {
  output: string; tokensUsed: number; costUsd: number;
}
