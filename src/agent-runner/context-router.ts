export function trimToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  if (text.length <= charBudget) return text;
  return `${text.slice(0, charBudget)}\n\n[...context truncated to fit ${tokenBudget} token budget...]`;
}

export function buildJobContext(upstreamOutputs: Record<string, string>, tokenBudget: number): string {
  if (!Object.keys(upstreamOutputs).length) return "";
  const sections = Object.entries(upstreamOutputs)
    .map(([jobId, output]) => `### Output from "${jobId}"\n${output}`)
    .join("\n\n");
  return trimToTokenBudget(sections, tokenBudget);
}
