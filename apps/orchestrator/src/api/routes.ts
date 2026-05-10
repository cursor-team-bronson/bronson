import { Router, Request, Response } from "express";
import { normalizeWorkflowYamlInput, parseWorkflowString } from "../parser/yaml-parser.js";
import { startRun, getRun, listRuns } from "../orchestrator/run-manager.js";
import { gateManager } from "../gates/gate-manager.js";
import { eventLog } from "../event-log/event-log.js";
import { streamRunEvents } from "./sse.js";
import { isSupabaseConfigured } from "../persist/supabase-client.js";
import {
  getWorkflowWithSteps,
  hydrateRunFromDatabase,
  listWorkflowRunsFromDb,
  listWorkflowsFromDb,
} from "../persist/supabase-sync.js";

export const router = Router();

router.post("/runs", async (req: Request, res: Response) => {
  try {
    const yamlStr = normalizeWorkflowYamlInput((req.body as { yaml?: unknown }).yaml);
    if (!yamlStr.trim()) {
      res.status(400).json({ error: "yaml field required" });
      return;
    }
    res.status(201).json(await startRun(parseWorkflowString(yamlStr), { rawYaml: yamlStr }));
  } catch (err) { res.status(400).json({ error: String(err) }); }
});

router.get("/runs", (_req, res) => res.json(listRuns()));

router.get("/runs/db/history", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "Supabase is not configured on this orchestrator" });
    return;
  }
  const limit = Number(req.query.limit) || 50;
  res.json(await listWorkflowRunsFromDb(limit));
});

router.get("/runs/:runId", async (req, res) => {
  let run = getRun(req.params.runId);
  if (!run && isSupabaseConfigured()) {
    run = (await hydrateRunFromDatabase(req.params.runId)) ?? undefined;
  }
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  res.json(run);
});

// Dedicated DAG endpoint for frontend (same payload as `RunState.dag`)
router.get("/runs/:runId/dag", async (req, res) => {
  let run = getRun(req.params.runId);
  if (!run && isSupabaseConfigured()) {
    run = (await hydrateRunFromDatabase(req.params.runId)) ?? undefined;
  }
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  if (!run.dag) { res.status(404).json({ error: "DAG not found for this run" }); return; }
  res.json(run.dag);
});

router.get("/runs/:runId/events", (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  streamRunEvents(res, req.params.runId);
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

router.get("/catalog/workflows", async (_req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "Supabase is not configured on this orchestrator" });
    return;
  }
  res.json(await listWorkflowsFromDb(50));
});

router.get("/catalog/workflows/:workflowId", async (req, res) => {
  if (!isSupabaseConfigured()) {
    res.status(503).json({ error: "Supabase is not configured on this orchestrator" });
    return;
  }
  const row = await getWorkflowWithSteps(req.params.workflowId);
  if (!row) { res.status(404).json({ error: "Workflow not found" }); return; }
  res.json(row);
});