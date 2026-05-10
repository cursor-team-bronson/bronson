import fs from "fs/promises";
import path from "path";
import { isShellToolEnabled } from "./shell-tool.js";

/**
 * When unset, defaults to the same as {@link isShellToolEnabled} so the essay flow only needs
 * `ALLOW_SHELL_TOOL=true` + `TOOL_SHELL_CWD`. Set to `false` to allow shell but block direct writes.
 */
export function isWorkspaceWriteEnabled(): boolean {
  const v = process.env.ALLOW_WORKSPACE_WRITE?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return isShellToolEnabled();
}

function workspaceRoot(): string {
  return path.resolve(process.env.TOOL_SHELL_CWD?.trim() || process.cwd());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Write a UTF-8 file under `TOOL_SHELL_CWD` (or `process.cwd()` if unset). Rejects `..` escapes.
 */
export async function executeWorkspaceWrite(args: { path: string; content: string }): Promise<string> {
  if (!isWorkspaceWriteEnabled()) {
    throw new Error(
      "workspace_write is disabled (set ALLOW_WORKSPACE_WRITE=true, or ALLOW_SHELL_TOOL=true to allow it by default).",
    );
  }

  const root = workspaceRoot();
  const rel = args.path.trim().replace(/^[/\\]+/, "");
  if (!rel) throw new Error("workspace_write: path must be non-empty");
  if (rel.includes("\0")) throw new Error("workspace_write: invalid path");

  const resolved = path.resolve(root, rel);
  const relativeFromRoot = path.relative(root, resolved);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error(`workspace_write: path escapes workspace: ${args.path}`);
  }

  const maxBytes = parsePositiveInt(process.env.TOOL_WORKSPACE_WRITE_MAX_BYTES, 5_000_000);
  const buf = Buffer.from(args.content, "utf8");
  if (buf.length > maxBytes) {
    throw new Error(`workspace_write: content exceeds TOOL_WORKSPACE_WRITE_MAX_BYTES (${maxBytes})`);
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, buf);

  return `ok: wrote ${buf.length} UTF-8 bytes to ${relativeFromRoot.split(path.sep).join("/")}`;
}
