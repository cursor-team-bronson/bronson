/** Opening / closing markers CLōD uses for tool markup in some model outputs (U+FF5C fullwidth `｜`). */
const DSML_FUNCTION_CALLS_OPEN = "<｜DSML｜function_calls>";
const DSML_FUNCTION_CALLS_CLOSE = "</｜DSML｜function_calls>";

/**
 * Removes DSML tool-call blocks from text that will be sent as a **user** message while `tools`
 * are enabled. CLōD re-parses that text and rejects incomplete blocks (400: missing end token).
 * Strips well-formed blocks and truncates from the first unclosed open tag onward.
 */
export function stripClodDsmlFromUserText(text: string): string {
  let s = text;
  for (;;) {
    const i = s.indexOf(DSML_FUNCTION_CALLS_OPEN);
    if (i === -1) break;
    const j = s.indexOf(DSML_FUNCTION_CALLS_CLOSE, i + DSML_FUNCTION_CALLS_OPEN.length);
    if (j === -1) {
      s = s.slice(0, i).trimEnd();
      break;
    }
    s = s.slice(0, i) + s.slice(j + DSML_FUNCTION_CALLS_CLOSE.length);
  }
  // Stray `<｜DSML｜invoke` / parameter fragments (not wrapped in function_calls) still break CLōD.
  const anyDsml = "<｜DSML｜";
  const k = s.indexOf(anyDsml);
  if (k !== -1) s = s.slice(0, k).trimEnd();
  return s;
}

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
