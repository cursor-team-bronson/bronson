import OpenAI from "openai";
import { AgentRunOptions, AgentRunResult } from "@bronson/types";
import { buildJobContext } from "./context-router.js";
import { eventLog } from "../event-log/event-log.js";
import { budgetTracker, BudgetExceededError } from "../orchestrator/budget-tracker.js";

const clod = new OpenAI({
  baseURL: process.env.CLOD_BASE_URL ?? "https://api.clod.io/v1",
  apiKey: process.env.CLOD_API_KEY ?? "",
});

export function assertClodConfigured(): void {
  if (!process.env.CLOD_API_KEY?.trim()) {
    throw new Error("CLOD_API_KEY environment variable must be set");
  }
}

export async function runAgent(
  runId: string,
  options: AgentRunOptions,
  upstreamOutputs: Record<string, string>,
): Promise<AgentRunResult> {
  const { jobId, jobConfig } = options;
  const contextSection = buildJobContext(upstreamOutputs, jobConfig.context_budget);
  const userMessage = contextSection
    ? `${contextSection}\n\n---\n\n${jobConfig.prompt}`
    : jobConfig.prompt;

  eventLog.append(runId, "JOB_STARTED", jobId);

  const response = await clod.chat.completions.create({
    model: jobConfig.model,
    messages: [{ role: "user", content: userMessage }],
  });

  const output = response.choices[0]?.message?.content ?? "";
  const usage = response.usage;
  const tokensUsed = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
  const costUsd = (response as any).cost ?? 0;

  // Deduct from budget. If exceeded, re-throw with the already-computed output
  // attached so run-manager can use it on resume instead of re-running the LLM.
  try {
    await budgetTracker.deduct(runId, jobId, costUsd);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      throw new BudgetExceededError(
        err.runId, err.jobId, err.spentUsd, err.limitUsd,
        err.checkoutUrl, err.intentId,
        output,
      );
    }
    throw err;
  }

  return { output, tokensUsed, costUsd };
}
