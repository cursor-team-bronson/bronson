import http from "node:http";
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

const basePort = Number(process.env.PORT) || 3001;
const rawTries = process.env.BRONSON_LISTEN_PORT_TRIES?.trim();
const maxTries = Math.min(
  32,
  Math.max(1, rawTries ? Number.parseInt(rawTries, 10) || 1 : 1),
);

const server = http.createServer(app);
let listenAttempt = 0;

function attachRuntimeServerErrors(): void {
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error("[bronson] HTTP server error:", err);
  });
}

function scheduleListenRetry(): void {
  const go = () => setImmediate(() => startListen());
  if (server.listening) {
    server.close(go);
  } else {
    go();
  }
}

function startListen(): void {
  const port = basePort + listenAttempt;
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && listenAttempt < maxTries - 1) {
      listenAttempt++;
      console.warn(
        `[bronson] Port ${port} is in use (EADDRINUSE). Trying ${port + 1} (${listenAttempt + 1}/${maxTries})…`,
      );
      scheduleListenRetry();
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(
        `[bronson] Cannot bind to port ${port}: address already in use.\n` +
          `  • Stop the other listener, or set PORT to a free port in apps/orchestrator/.env.\n` +
          `  • Optional: set BRONSON_LISTEN_PORT_TRIES=5 to try PORT…PORT+4 automatically.\n` +
          `  • Windows (elevated optional): Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`,
      );
      process.exit(1);
    }
    console.error("[bronson] Failed to start HTTP server:", err);
    process.exit(1);
  });

  server.listen(port, () => {
    server.removeAllListeners("error");
    attachRuntimeServerErrors();
    if (listenAttempt > 0) {
      console.warn(
        `[bronson] Listening on ${port} after ${listenAttempt} fallback port(s). ` +
          `Use ORCHESTRATOR_URL=http://127.0.0.1:${port} for the web app (see apps/web .env).`,
      );
    }
    console.log(`Bronson orchestrator running on http://localhost:${port}`);
  });
}

function shutdown(signal: string): void {
  console.log(`[bronson] Received ${signal}, closing HTTP server…`);
  server.close(() => {
    console.log("[bronson] HTTP server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startListen();
