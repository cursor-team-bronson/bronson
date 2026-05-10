import { Router, Request, Response } from "express";
import { parseWorkflowString } from "../parser/yaml-parser.js";
import { startRun, getRun, listRuns } from "../orchestrator/run-manager.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { createSSEStream, formatSseRunEvent } from "./sse.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const { yaml } = req.body as { yaml?: string };
    if (!yaml) { res.status(400).json({ error: "yaml field required" }); return; }
    res.status(201).json(await startRun(parseWorkflowString(yaml)));
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.get("/runs", (_req, res) => res.json(listRuns()));

router.get("/runs/:runId", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

router.get("/runs/:runId/events", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  const past = eventLog.getEventsForRun(req.params.runId);
  createSSEStream(res, req.params.runId);
  for (const e of past) res.write(formatSseRunEvent(e));
});

router.get("/runs/:runId/events/history", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(eventLog.getEventsForRun(req.params.runId));
});

router.get("/runs/:runId/gates", (req, res) => res.json(gateManager.listPending(req.params.runId)));

router.post("/runs/:runId/gates/:jobId/approve", (req, res) => {
  try { gateManager.approve(req.params.runId, req.params.jobId, (req.body as any).editedOutput); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: String(err) }); }
});

router.post("/runs/:runId/gates/:jobId/reject", (req, res) => {
  try { gateManager.reject(req.params.runId, req.params.jobId, (req.body as any).reason); res.json({ ok: true }); }
  catch (err) { res.status(404).json({ error: String(err) }); }
});
