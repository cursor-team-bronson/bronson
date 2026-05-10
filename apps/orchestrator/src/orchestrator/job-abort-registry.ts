/** In-flight LLM requests per (runId, jobId); abort stops the current OpenAI/CLōD HTTP call. */

const controllers = new Map<string, AbortController>();

function k(runId: string, jobId: string): string {
  return `${runId}\0${jobId}`;
}

/** Register a fresh controller for this job attempt; replaces any previous controller for the same key. */
export function attachJobAbort(runId: string, jobId: string): AbortController {
  const key = k(runId, jobId);
  const prev = controllers.get(key);
  if (prev) prev.abort();
  const ac = new AbortController();
  controllers.set(key, ac);
  return ac;
}

export function detachJobAbort(runId: string, jobId: string): void {
  controllers.delete(k(runId, jobId));
}

/** Abort the current model HTTP request for this job, if any. */
export function stopJobRequest(runId: string, jobId: string): boolean {
  const ac = controllers.get(k(runId, jobId));
  if (!ac) return false;
  ac.abort();
  return true;
}
