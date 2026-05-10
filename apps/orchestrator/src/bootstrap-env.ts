import fs from "fs";
import path from "path";
import { config as loadEnv } from "dotenv";

/**
 * Resolve `.env` paths from this module's directory (`src/` under dev, `dist/` when compiled)
 * so load order does not depend on `process.cwd()` or folder names like `orchestrator`.
 */
function envPathCandidates(): string[] {
  const orchestratorRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(orchestratorRoot, "..", "..");

  return [path.join(repoRoot, ".env"), path.join(orchestratorRoot, ".env")];
}

/**
 * Load merged `.env` files before any module that reads `process.env` for CLōD.
 * Must be imported first from `index.ts` so `clod-client` sees real keys at init.
 */
function loadMergedEnv(): string[] {
  const ordered = envPathCandidates();

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

export const loadedEnvPaths = loadMergedEnv();
