import { loadedEnvPaths } from "./bootstrap-env.js";
import express from "express";
import cors from "cors";
import { router } from "./api/routes.js";
import { assertClodConfigured } from "./agent-runner/clod-client.js";
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
