import fs from "fs";
import path from "path";
import { config as loadEnv } from "dotenv";
import express from "express";
import cors from "cors";
import { router } from "./api/routes.js";
import { assertClodConfigured } from "./agent-runner/clod-client.js";

/**
 * Load multiple `.env` files so package-local settings override repo root.
 * Previously we stopped at the first existing file, so `bronson/.env` hid
 * `apps/orchestrator/.env` and left CLōD keys unset or stale.
 */
function loadMergedEnv(): string[] {
  const cwd = process.cwd();
  const ordered: string[] =
    path.basename(cwd) === "orchestrator"
      ? [path.join(cwd, "..", "..", ".env"), path.join(cwd, ".env")]
      : [path.join(cwd, ".env"), path.join(cwd, "apps", "orchestrator", ".env")];

  const loaded: string[] = [];
  const seen = new Set<string>();

  for (const p of ordered) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    if (!fs.existsSync(abs)) continue;
    seen.add(abs);
    loadEnv({ path: abs, override: true });
    loaded.push(abs);
  }

  if (loaded.length === 0) {
    loadEnv();
  }

  return loaded;
}

const loadedEnvPaths = loadMergedEnv();
assertClodConfigured();

const modelFromEnv =
  process.env.DEFAULT_AGENT_MODEL?.trim() ||
  process.env.CLOD_DEFAULT_MODEL?.trim() ||
  "";

console.log("[bronson] Loaded .env files:", loadedEnvPaths.join(", ") || "(dotenv default search)");
console.log(
  "[bronson] CLōD endpoint:",
  process.env.CLOD_BASE_URL?.trim() || "https://api.clod.io/v1 (default)",
);
console.log("[bronson] Default model:", JSON.stringify(modelFromEnv || "(none — set DEFAULT_AGENT_MODEL)"));
console.log(
  "[bronson] CLOD_API_KEY:",
  process.env.CLOD_API_KEY?.trim()
    ? `present (${process.env.CLOD_API_KEY.length} chars)`
    : "MISSING",
);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", router);
const port = Number(process.env.PORT) || 3001;
app.listen(port, () =>
  console.log(`Bronson orchestrator running on http://localhost:${port}`)
);
