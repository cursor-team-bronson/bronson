import OpenAI from "openai";
import { AgentRunOptions, AgentRunResult } from "@bronson/types";
import { buildJobContext, stripClodDsmlFromUserText } from "./context-router.js";
import { eventLog } from "../event-log/event-log.js";
import { resolveTools } from "./tool-registry.js";
import { resolveAgentModel } from "./resolve-model.js";
import { budgetTracker, BudgetExceededError } from "../orchestrator/budget-tracker.js";

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
    if (err.code) bits.push(`code=${err.code}`);
    if (err.type) bits.push(`type=${err.type}`);
    if (err.param) bits.push(`param=${err.param}`);
    if (err.request_id) bits.push(`request_id=${err.request_id}`);
    let s = bits.filter(Boolean).join(" — ");
    if (err.status === 403) {
      s +=
        " — Check CLOD_API_KEY, DEFAULT_AGENT_MODEL (exact catalog id, e.g. DeepSeek V3), project key scope on app.clod.io.";
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

  const toolNames = jobConfig.tools ?? [];
  const resolved = toolNames.length > 0 ? resolveTools(toolNames) : { tools: [] as OpenAI.Chat.ChatCompletionTool[], execute: new Map<string, (a: Record<string, unknown>) => Promise<string>>() };

  // Prior jobs' stored outputs can contain partial DSML tool markup; CLōD rejects that inside a
  // new user message when this job has tools enabled (same 400 as incomplete assistant content).
  if (resolved.tools.length) userMessage = stripClodDsmlFromUserText(userMessage);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: userMessage }];
  const maxRounds = jobConfig.tool_rounds_max ?? 12;
  const model = resolveAgentModel(jobConfig);

  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCost = 0;

  for (let round = 0; round < maxRounds; round++) {
    abortSignal?.throwIfAborted();
    let response;
    try {
      response = await clod.chat.completions.create(
        {
          model,
          messages,
          tools: resolved.tools.length ? resolved.tools : undefined,
          tool_choice: resolved.tools.length ? "auto" : undefined,
        },
        { signal: abortSignal ?? undefined },
      );
    } catch (e) {
      if (e instanceof OpenAI.APIUserAbortError) {
        throw new Error("Stopped by user");
      }
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error("Stopped by user");
      }
      throw new Error(formatClodRequestError(e));
    }

    const usage = response.usage;
    if (usage) {
      const pt = usage.prompt_tokens ?? 0;
      const ct = usage.completion_tokens ?? 0;
      totalPromptTokens += pt;
      totalCompletionTokens += ct;
      totalTokens += pt + ct;
    }
    totalCost += Number((response as { cost?: number }).cost ?? 0);

    // Deduct from budget after each round. If exceeded, re-throw with the
    // final output attached *only* when this was a terminal round (no tool
    // calls). When the model returned tool_calls, content is null — passing
    // undefined tells run-manager to retry the entire agent call after funding.
    try {
      await budgetTracker.deduct(runId, jobId, Number((response as { cost?: number }).cost ?? 0));
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const msg = response.choices[0]?.message;
        const isFinalAnswer = !msg?.tool_calls?.length && msg?.content != null;
        throw new BudgetExceededError(
          err.runId, err.jobId, err.spentUsd, err.limitUsd,
          err.checkoutUrl, err.intentId,
          isFinalAnswer ? msg!.content! : undefined,
          totalTokens, totalCost,
        );
      }
      throw err;
    }

    const msg = response.choices[0]?.message;
    if (!msg) throw new Error("No assistant message in completion response");

    // CLōD may treat assistant `content` as DSML when tools are in play. Models sometimes emit
    // incomplete DSML in `content` alongside structured `tool_calls`; re-sending that `content`
    // on the next request triggers 400 ("Missing end token '</｜DSML｜function_calls>'"). Match
    // OpenAI guidance: omit prose when this turn is tool-driven (`content: null`).
    messages.push({
      role: "assistant",
      content: msg.tool_calls?.length ? null : (msg.content ?? null),
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls?.length) {
      return {
        output: msg.content ?? "",
        tokensUsed: totalTokens,
        costUsd: totalCost,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Error: unsupported tool call type "${tc.type}" (only function tools are implemented).`,
        });
        continue;
      }
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
