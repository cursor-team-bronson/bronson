import type { UpstreamKind } from "@bronson/types";

export function trimToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget)}\n\n[...context truncated to fit ${tokenBudget} token budget...]`;
}

export function buildJobContext(
  upstreamOutputs: Record<string, string>,
  tokenBudget: number,
  upstreamKind?: Record<string, UpstreamKind>,
): string {
  if (!Object.keys(upstreamOutputs).length) return "";
  const sections = Object.entries(upstreamOutputs).map(([jobId, output]) => {
    const kind = upstreamKind?.[jobId] ?? "completed";
    const title =
      kind === "failed"
        ? `### Upstream "${jobId}" failed (errors / retries — proceed if you can)`
        : `### Output from "${jobId}"`;
    return `${title}\n${output}`;
  });
  const joined = sections.join("\n\n");
  return trimToTokenBudget(joined, tokenBudget);
}
