import { Response } from "express";
import { eventLog } from "../event-log/event-log.js";
import { v4 as uuidv4 } from "uuid";

export function createSSEStream(res: Response, runId: string): () => void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const id = uuidv4();
  eventLog.subscribe(id, event => {
    if (event.runId === runId) res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const cleanup = () => eventLog.unsubscribe(id);
  res.on("close", cleanup);
  return cleanup;
}
