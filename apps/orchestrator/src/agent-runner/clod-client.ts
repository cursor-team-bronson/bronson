import OpenAI from "openai";
import { AgentRunOptions, AgentRunResult } from "@bronson/types";
import { buildJobContext } from "./context-router.js";
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

function formatPriorAttempts(errors: string[]): string {
  const lines = errors.map((e, i) => `${i + 1}. ${e}`);
  return `### Prior attempts on this job (learn from these errors)\n${lines.join("\n")}`;
}

/** True when the model ended with a shell-only terminator (essay lives in the previous assistant turn). */
function trivialTerminator(content: string): boolean {
  const t = content.trim();
  return t.length === 0 || /^(done|ok|finished|complete)\.?$/i.test(t);
}

function resolveFinalAssistantOutput(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  lastAssistantContent: string | null,
): string {
  const chunks: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string" && c.trim().length > 0) chunks.push(c);
  }
  const last = lastAssistantContent ?? "";
  if (!trivialTerminator(last)) return last;
  /** Essay pattern: penultimate turn holds draft; last turn is "done". */
  if (chunks.length >= 2) return chunks[chunks.length - 2]!;
  if (chunks.length === 1) return chunks[0]!;
  if (chunks.length > 0) return chunks.join("\n\n");
  if (last.trim().length > 0) return last;
  return (
    "[No assistant text was captured (tool-only turns). Add a final instruction in YAML for the model " +
    "to emit required markers or summary prose, or raise tool_rounds_max / context_budget.]"
  );
}

export async function runAgent(
  runId: string,
  options: AgentRunOptions,
  upstreamOutputs: Record<string, string>,
): Promise<AgentRunResult> {
  const { jobId, jobConfig, priorAttemptErrors, upstreamKind } = options;
  const contextSection = buildJobContext(upstreamOutputs, jobConfig.context_budget, upstreamKind);
  const attemptSection =
    priorAttemptErrors && priorAttemptErrors.length > 0 ? `${formatPriorAttempts(priorAttemptErrors)}\n\n---\n\n` : "";
  const body = contextSection ? `${contextSection}\n\n---\n\n${jobConfig.prompt}` : jobConfig.prompt;
  const userMessage = attemptSection ? `${attemptSection}${body}` : body;

  eventLog.append(runId, "JOB_STARTED", jobId);

  const toolNames = jobConfig.tools ?? [];
  const resolved =
    toolNames.length > 0
      ? resolveTools(toolNames)
      : { tools: [] as OpenAI.Chat.ChatCompletionTool[], execute: new Map<string, (a: Record<string, unknown>) => Promise<string>>() };

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

    try {
      await budgetTracker.deduct(runId, jobId, Number((response as { cost?: number }).cost ?? 0));
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const isFinalAnswer = !msg.tool_calls?.length && msg.content != null;
        throw new BudgetExceededError(
          err.runId,
          err.jobId,
          err.spentUsd,
          err.limitUsd,
          err.checkoutUrl,
          err.intentId,
          isFinalAnswer ? msg.content! : undefined,
          totalTokens,
          totalCost,
        );
      }
      throw err;
    }

    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    if (!msg.tool_calls?.length) {
      return {
        output: resolveFinalAssistantOutput(messages, msg.content ?? null),
        tokensUsed: totalTokens,
        costUsd: totalCost,
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

  throw new Error(
    `Tool / assistant loop exceeded tool_rounds_max (${maxRounds}). ` +
      `Raise tool_rounds_max on this job in YAML (shell-heavy jobs often need 40–64).`,
  );
}
