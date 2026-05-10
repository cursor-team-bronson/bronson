import { Response } from "express";
import { eventLog } from "../event-log/event-log.js";
import { v4 as uuidv4 } from "uuid";
import { RunEvent } from "@bronson/types";

export function formatSseRunEvent(event: RunEvent): string {
  return `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`;
}

function prepareSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Opens an SSE stream: replays history (with two passes to close snapshot gaps), then subscribes.
 * Uses `delivered` so live notifications never duplicate replayed eventIds.
 */
export function streamRunEvents(res: Response, runId: string): () => void {
  prepareSseHeaders(res);
  const delivered = new Set<string>();
  const replay = () => {
    for (const e of eventLog.getEventsForRun(runId)) {
      if (delivered.has(e.eventId)) continue;
      delivered.add(e.eventId);
      res.write(formatSseRunEvent(e));
    }
  };
  replay();
  replay();

  const subId = uuidv4();
  eventLog.subscribe(subId, event => {
    if (event.runId !== runId) return;
    if (delivered.has(event.eventId)) return;
    delivered.add(event.eventId);
    res.write(formatSseRunEvent(event));
  });
  const cleanup = () => eventLog.unsubscribe(subId);
  res.on("close", cleanup);
  return cleanup;
}
