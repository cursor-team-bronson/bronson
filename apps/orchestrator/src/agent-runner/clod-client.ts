import OpenAI from "openai";
import { AgentRunOptions, AgentRunResult } from "@bronson/types";
import { buildJobContext } from "./context-router.js";
import { eventLog } from "../event-log/event-log.js";
import { resolveTools } from "./tool-registry.js";
import { resolveAgentModel } from "./resolve-model.js";

const clod = new OpenAI({
  baseURL: process.env.CLOD_BASE_URL ?? "https://api.clod.io/v1",
  apiKey: process.env.CLOD_API_KEY ?? "",
});

/** Richer errors for CLōD/OpenAI HTTP failures (403, 429, etc.). */
function formatClodRequestError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    const bits = [`HTTP ${err.status}`, err.message];
    const body = err.error as { message?: string } | undefined;
    if (body && typeof body === "object" && typeof body.message === "string" && body.message !== err.message) {
      bits.push(body.message);
    }
    let s = bits.filter(Boolean).join(" — ");
    if (err.status === 403) {
      s +=
        " — Check CLOD_API_KEY, DEFAULT_AGENT_MODEL (model slug allowed on your plan), and CLōD dashboard access.";
    }
    return s;
  }
  return String(err);
}

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

  const toolNames = jobConfig.tools ?? [];
  const resolved = toolNames.length > 0 ? resolveTools(toolNames) : { tools: [] as OpenAI.Chat.ChatCompletionTool[], execute: new Map<string, (a: Record<string, unknown>) => Promise<string>>() };

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: userMessage }];
  const maxRounds = jobConfig.tool_rounds_max ?? 12;
  const model = resolveAgentModel(jobConfig);

  let totalTokens = 0;
  let totalCost = 0;

  for (let round = 0; round < maxRounds; round++) {
    let response;
    try {
      response = await clod.chat.completions.create({
        model,
        messages,
        tools: resolved.tools.length ? resolved.tools : undefined,
        tool_choice: resolved.tools.length ? "auto" : undefined,
      });
    } catch (e) {
      throw new Error(formatClodRequestError(e));
    }

    const usage = response.usage;
    if (usage) totalTokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    totalCost += Number((response as { cost?: number }).cost ?? 0);

    const msg = response.choices[0]?.message;
    if (!msg) throw new Error("No assistant message in completion response");

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls?.length) {
      return {
        output: msg.content ?? "",
        tokensUsed: totalTokens,
        costUsd: totalCost,
      };
    }

    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const fn = tc.function.name;
      const exec = resolved.execute.get(fn);
      let toolContent: string;
      try {
        const rawArgs = tc.function.arguments ?? "{}";
        const args = JSON.parse(rawArgs) as Record<string, unknown>;
        toolContent = exec ? await exec(args) : `Error: no executor for tool "${fn}"`;
      } catch (e) {
        toolContent = `Error: ${String(e)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolContent,
      });
    }
  }

  throw new Error(`Tool / assistant loop exceeded tool_rounds_max (${maxRounds})`);
}
