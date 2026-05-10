import OpenAI from "openai";
import { AgentRunOptions, AgentRunResult } from "../types/index.js";
import { buildJobContext } from "./context-router.js";
import { eventLog } from "../event-log/event-log.js";

const clod = new OpenAI({
  baseURL: process.env.CLOD_BASE_URL ?? "https://api.clod.io/v1",
  apiKey: process.env.CLOD_API_KEY ?? "",
});

export function assertClodConfigured(): void {
  if (!process.env.CLOD_API_KEY?.trim()) {
    throw new Error("CLOD_API_KEY environment variable must be set");
  }
}

export async function runAgent(runId: string, options: AgentRunOptions, upstreamOutputs: Record<string, string>): Promise<AgentRunResult> {
  const { jobId, jobConfig } = options;
  const contextSection = buildJobContext(upstreamOutputs, jobConfig.context_budget);
  const userMessage = contextSection ? `${contextSection}\n\n---\n\n${jobConfig.prompt}` : jobConfig.prompt;

  eventLog.append(runId, "JOB_STARTED", jobId);

  const response = await clod.chat.completions.create({
    model: jobConfig.model,
    messages: [{ role: "user", content: userMessage }],
  });

  const output = response.choices[0]?.message?.content ?? "";
  const usage = response.usage;
  const tokensUsed = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
  const costUsd = (response as any).cost ?? 0;
  return { output, tokensUsed, costUsd };
}
