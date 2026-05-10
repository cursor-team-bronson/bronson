import { createCheckoutIntent } from "../integrations/allscale.js";

export class BudgetExceededError extends Error {
  constructor(
    readonly runId: string,
    readonly jobId: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
    readonly checkoutUrl: string,
    readonly intentId: string,
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
          orderId: `${runId}-${jobId}-${Date.now()}`,
          description: `Budget top-up for job "${jobId}" in run "${runId}"`,
        });
        entry.intentId = checkout.intent_id;
        entry.checkoutUrl = checkout.checkout_url;
      } catch (err) {
        // AllScale unavailable (e.g. no keys in dev) — still block the job
        entry.checkoutUrl = `[AllScale unavailable: ${String(err)}]`;
      }
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
   */
  waitForFunding(runId: string, jobId: string): Promise<void> {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry) return Promise.resolve();

    entry.awaiting = true;
    return new Promise<void>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
  }

  /** Called when AllScale webhook confirms payment. Resets spend and resumes execution. */
  topUp(runId: string, jobId: string, amountUsd: number) {
    const k = this.key(runId, jobId);
    const entry = this.state.get(k);
    if (!entry) throw new Error(`No budget entry for ${runId}::${jobId}`);

    entry.spentUsd = Math.max(0, entry.spentUsd - amountUsd);
    entry.intentId = undefined;
    entry.checkoutUrl = undefined;
    entry.awaiting = false;

    if (entry.resolve) {
      const resolve = entry.resolve;
      entry.resolve = undefined;
      entry.reject = undefined;
      resolve();
    }
  }

  getState(runId: string, jobId: string): Readonly<JobBudgetState> | undefined {
    return this.state.get(this.key(runId, jobId));
  }

  listAwaiting(runId: string) {
    return [...this.state.entries()]
      .filter(([k, v]) => k.startsWith(runId + "::") && v.awaiting)
      .map(([k, v]) => ({ jobId: k.split("::")[1], ...v }));
  }
}

export const budgetTracker = new BudgetTracker();
