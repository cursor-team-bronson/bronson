import { createCheckoutIntent } from "../integrations/allscale.js";

export class BudgetExceededError extends Error {
  constructor(
    readonly runId: string,
    readonly jobId: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    readonly checkoutUrl: string,
    readonly intentId: string,
    /** LLM output already produced before the budget was exceeded — avoids a duplicate call on resume. */
    readonly output?: string,
    readonly tokensUsed?: number,
    readonly costUsd?: number,
  ) {
    super(
      `Job "${jobId}" exceeded budget $${limitUsd.toFixed(4)} (spent $${spentUsd.toFixed(4)}). Fund at: ${checkoutUrl}`,
    );
    this.name = "BudgetExceededError";
  }
}

interface JobBudgetState {
  limitUsd: number;
  spentUsd: number;
  intentId?: string;
  checkoutUrl?: string;
  resolve?: () => void;
  reject?: (e: Error) => void;
  awaiting: boolean;
  /** Set to true after topUp resolves the gate; prevents duplicate webhook deliveries from double-decrementing. */
  settled: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

class BudgetTracker {
  private state = new Map<string, JobBudgetState>();

  private key(runId: string, jobId: string) {
    return `${runId}::${jobId}`;
  }

  /** Call this before a job starts to register its budget. */
  register(runId: string, jobId: string, limitUsd: number) {
    this.state.set(this.key(runId, jobId), {
      limitUsd,
      spentUsd: 0,
      awaiting: false,
      settled: false,
    });
  }

  /** Deduct cost after an LLM call. Throws BudgetExceededError when limit is hit. */
  async deduct(runId: string, jobId: string, costUsd: number): Promise<void> {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry) return; // no budget configured for this job

    entry.spentUsd += costUsd;
    if (entry.spentUsd <= entry.limitUsd) return;

    // Budget exceeded — create AllScale checkout if not already created
    if (!entry.intentId) {
      const topupAmount = entry.limitUsd; // top up by the original limit
      try {
        const checkout = await createCheckoutIntent({
          amountUsdc: topupAmount,
          orderId: `${runId}::${jobId}::${Date.now()}`,
          description: `Budget top-up for job "${jobId}" in run "${runId}"`,
          redirectUrl: `${process.env.NEXT_PUBLIC_URL ?? "http://localhost:3000"}/runs/${runId}`,
        });
        entry.intentId = checkout.intent_id;
        entry.checkoutUrl = checkout.checkout_url;
      } catch (err) {
        // AllScale unavailable (e.g. no keys in dev)
        entry.checkoutUrl = `[AllScale unavailable: ${String(err)}]`;
      }
    }

    /**
     * Without a working checkout URL, awaiting funding would hang until timeout.
     * Default: fail the job immediately with a clear error unless explicitly opting into the pause.
     */
    const checkoutBroken = entry.checkoutUrl?.startsWith("[AllScale unavailable") ?? false;
    const forceAwaitFunding =
      process.env.BRONSON_BUDGET_ON_EXCEED?.trim().toLowerCase() === "await_funding";

    if (checkoutBroken && !forceAwaitFunding) {
      throw new Error(
        `Budget exceeded for job "${jobId}" (spent $${entry.spentUsd.toFixed(4)} vs limit $${entry.limitUsd.toFixed(4)}). ` +
          `Payment checkout could not be created. Configure AllScale credentials, increase budget_usd in YAML, ` +
          `or set BRONSON_BUDGET_ON_EXCEED=await_funding to pause until manual top-up.`,
      );
    }

    throw new BudgetExceededError(
      runId,
      jobId,
      entry.spentUsd,
      entry.limitUsd,
      entry.checkoutUrl ?? "",
      entry.intentId ?? "",
    );
  }

  /**
   * Suspend execution until funds arrive. Returns a Promise that resolves
   * when topUp() is called (e.g. from the AllScale webhook).
   * Rejects after timeoutMs if never funded (default: 1 hour).
   *
   * Race-safe: if topUp() was called before waitForFunding() (e.g. webhook
   * arrived while run-manager was emitting events), the settled flag is
   * already true and we resolve immediately without blocking.
   */
  waitForFunding(runId: string, jobId: string, timeoutMs = 3_600_000): Promise<void> {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry) return Promise.resolve();

    if (entry.settled) {
      entry.awaiting = false;
      entry.settled = false;
      return Promise.resolve();
    }

    entry.awaiting = true;
    return new Promise<void>((resolve, reject) => {
      if (entry.settled) {
        entry.awaiting = false;
        entry.settled = false;
        resolve();
        return;
      }

      entry.resolve = resolve;
      entry.reject = reject;

      entry.timeoutHandle = setTimeout(() => {
        if (!entry.settled) {
          entry.awaiting = false;
          entry.resolve = undefined;
          entry.reject = undefined;
          reject(new Error(`Job "${jobId}" funding timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  /** Called when AllScale webhook confirms payment. Idempotent — duplicate deliveries are ignored. */
  topUp(runId: string, jobId: string, amountUsd: number) {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry) throw new Error(`No budget entry for ${runId}::${jobId}`);
    if (entry.settled) return; // duplicate webhook delivery — no-op

    entry.settled = true;
    entry.spentUsd = Math.max(0, entry.spentUsd - amountUsd);
    entry.intentId = undefined;
    entry.checkoutUrl = undefined;
    entry.awaiting = false;

    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }

    if (entry.resolve) {
      const resolve = entry.resolve;
      entry.resolve = undefined;
      entry.reject = undefined;
      resolve();
    }

    // Reset settled so a second budget-exceeded cycle on the same job
    // does not instantly bypass the gate.
    queueMicrotask(() => { entry.settled = false; });
  }

  /** Cancel a pending funding gate — rejects the waitForFunding promise. */
  cancelFunding(runId: string, jobId: string, reason = "Funding cancelled") {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry?.reject) return;

    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }

    const reject = entry.reject;
    entry.resolve = undefined;
    entry.reject = undefined;
    entry.awaiting = false;
    reject(new Error(reason));
  }

  getState(runId: string, jobId: string): Readonly<JobBudgetState> | undefined {
    return this.state.get(this.key(runId, jobId));
  }

  listAwaiting(runId: string) {
    return [...this.state.entries()]
      .filter(([k, v]) => k.startsWith(runId + "::") && v.awaiting)
      .map(([k, v]) => ({
        jobId: k.split("::")[1],
        limitUsd: v.limitUsd,
        spentUsd: v.spentUsd,
        intentId: v.intentId,
        checkoutUrl: v.checkoutUrl,
      }));
  }
}

export const budgetTracker = new BudgetTracker();
