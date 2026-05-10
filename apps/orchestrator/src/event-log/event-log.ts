import { v4 as uuidv4 } from "uuid";
import { EventType, RunEvent } from "@bronson/types";

/** Oldest events for a run are dropped once this count is exceeded (per-run cap). */
const MAX_EVENTS_PER_RUN = 20_000;

export class VersionMismatchError extends Error {
  constructor(
    readonly runId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Event log version mismatch for run ${runId}: expected tail ${expectedVersion}, actual ${currentVersion}`,
    );
    this.name = "VersionMismatchError";
  }
}

export class EventLog {
  private events: RunEvent[] = [];
  /** Latest committed version number per run (0 if no events yet). */
  private lastVersion = new Map<string, number>();
  private subscribers = new Map<string, (event: RunEvent) => void>();

  getLastVersion(runId: string): number {
    return this.lastVersion.get(runId) ?? 0;
  }

  append(
    runId: string,
    type: EventType,
    jobId?: string,
    payload?: Record<string, unknown>,
    expectedVersion?: number,
  ): RunEvent {
    const current = this.lastVersion.get(runId) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== current) {
      throw new VersionMismatchError(runId, expectedVersion, current);
    }
    const nextVersion = current + 1;
    const event: RunEvent = {
      eventId: uuidv4(),
      runId,
      jobId,
      type,
      timestamp: new Date().toISOString(),
      version: nextVersion,
      payload,
    };
    this.lastVersion.set(runId, nextVersion);
    this.events.push(event);
    this.pruneRunIfNeeded(runId);
    this.notify(event);
    return event;
  }

  private pruneRunIfNeeded(runId: string) {
    let countForRun = 0;
    for (const e of this.events) if (e.runId === runId) countForRun++;
    if (countForRun <= MAX_EVENTS_PER_RUN) return;
    const toDrop = countForRun - MAX_EVENTS_PER_RUN;
    let dropped = 0;
    this.events = this.events.filter(e => {
      if (e.runId !== runId) return true;
      if (dropped < toDrop) {
        dropped++;
        return false;
      }
      return true;
    });
    this.recomputeLastVersion(runId);
  }

  private recomputeLastVersion(runId: string) {
    let max = 0;
    for (const e of this.events) {
      if (e.runId === runId) max = Math.max(max, e.version);
    }
    if (max === 0) this.lastVersion.delete(runId);
    else this.lastVersion.set(runId, max);
  }

  getEventsForRun(runId: string) {
    return this.events.filter(e => e.runId === runId);
  }

  getJobOutput(runId: string, jobId: string): string | undefined {
    return [...this.events].reverse()
      .find(e => e.runId === runId && e.jobId === jobId && e.type === "JOB_COMPLETED")
      ?.payload?.output as string | undefined;
  }

  /**
   * Text for dependents when a dependency never completed successfully: retry warnings + final error.
   * Returns undefined if the job completed (normal output available via {@link getJobOutput}) or no failure events exist.
   */
  getFailureContextForJob(runId: string, jobId: string): string | undefined {
    if (this.getJobOutput(runId, jobId) !== undefined) return undefined;
    const relevant = this.getEventsForRun(runId)
      .filter(
        e =>
          e.jobId === jobId &&
          (e.type === "JOB_RETRY_WARNING" ||
            e.type === "JOB_FAILED" ||
            e.type === "GATE_REJECTED"),
      )
      .sort((a, b) => a.version - b.version);
    if (relevant.length === 0) return undefined;
    const lines: string[] = [];
    for (const e of relevant) {
      if (e.type === "JOB_RETRY_WARNING") {
        const p = e.payload as { attempt?: number; maxAttempts?: number; reason?: string };
        lines.push(
          `- After attempt ${p.attempt ?? "?"} of ${p.maxAttempts ?? "?"}: ${p.reason ?? "(no reason)"}`,
        );
      } else if (e.type === "JOB_FAILED") {
        const p = e.payload as { error?: string };
        lines.push(`- Final failure: ${p.error ?? "(no error text)"}`);
      } else if (e.type === "GATE_REJECTED") {
        const p = e.payload as { reason?: string };
        lines.push(`- Human gate rejected: ${p.reason ?? "(no reason)"}`);
      }
    }
    return lines.join("\n");
  }

  subscribe(id: string, handler: (e: RunEvent) => void) {
    this.subscribers.set(id, handler);
  }
  unsubscribe(id: string) {
    this.subscribers.delete(id);
  }

  private notify(event: RunEvent) {
    for (const h of this.subscribers.values()) try { h(event); } catch {}
  }
}

export const eventLog = new EventLog();
