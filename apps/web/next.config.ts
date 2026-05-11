import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * npm workspaces hoist deps to the monorepo root, so `apps/web` often has no
 * local `node_modules/undici`. Turbopack only resolves inside its project root
 * (see https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory),
 * so point that root at the repo root when undici is hoisted.
 */
function turbopackMonorepoRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "node_modules", "undici", "package.json"))) {
    return cwd;
  }
  const hoistedFromWeb = path.join(cwd, "..", "..", "node_modules", "undici", "package.json");
  if (fs.existsSync(hoistedFromWeb)) {
    return path.resolve(cwd, "..", "..");
  }
  return cwd;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: turbopackMonorepoRoot(),
  },
  serverExternalPackages: ["undici"],
};

export default nextConfig;
