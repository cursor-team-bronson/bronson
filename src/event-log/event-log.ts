import { v4 as uuidv4 } from "uuid";
import { EventType, RunEvent } from "../types/index.js";

export class EventLog {
  private events: RunEvent[] = [];
  private subscribers = new Map<string, (event: RunEvent) => void>();

  append(runId: string, type: EventType, jobId?: string, payload?: Record<string, unknown>): RunEvent {
    const event: RunEvent = { eventId: uuidv4(), runId, jobId, type, timestamp: new Date().toISOString(), payload };
    this.events.push(event);
    this.notify(event);
    return event;
  }

  getEventsForRun(runId: string) { return this.events.filter(e => e.runId === runId); }

  getJobOutput(runId: string, jobId: string): string | undefined {
    return [...this.events].reverse()
      .find(e => e.runId === runId && e.jobId === jobId && e.type === "JOB_COMPLETED")
      ?.payload?.output as string | undefined;
  }

  subscribe(id: string, handler: (e: RunEvent) => void) { this.subscribers.set(id, handler); }
  unsubscribe(id: string) { this.subscribers.delete(id); }

  private notify(event: RunEvent) {
    for (const h of this.subscribers.values()) try { h(event); } catch {}
  }
}

export const eventLog = new EventLog();
