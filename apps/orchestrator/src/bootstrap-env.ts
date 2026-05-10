import fs from "fs";
import path from "path";
import { config as loadEnv } from "dotenv";

/**
 * Load merged `.env` files before any module that reads `process.env` for CLōD.
 * Must be imported first from `index.ts` so `clod-client` sees real keys at init.
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

export const loadedEnvPaths = loadMergedEnv();
