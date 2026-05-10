import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export function isShellToolEnabled(): boolean {
  return process.env.ALLOW_SHELL_TOOL?.trim().toLowerCase() === "true";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function drainLimited(stream: Readable, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (received >= maxBytes) return;
      const room = maxBytes - received;
      const take = buf.length > room ? buf.subarray(0, room) : buf;
      chunks.push(take);
      received += take.length;
    });
    stream.on("error", reject);
    stream.on("end", () =>
      resolve({
        text: Buffer.concat(chunks).toString("utf8"),
        truncated: received >= maxBytes,
      }),
    );
  });
}

/**
 * Runs `command` via the system shell (`spawn(..., { shell: true })`).
 * POC-only: requires ALLOW_SHELL_TOOL=true and respects env limits / optional allowlist.
 */
export async function executeShellCommand(command: string): Promise<string> {
  if (!isShellToolEnabled()) {
    throw new Error("Shell tool is disabled (set ALLOW_SHELL_TOOL=true on the orchestrator)");
  }
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command must be non-empty");

  const allowlist = process.env.TOOL_SHELL_ALLOWLIST_REGEX?.trim();
  if (allowlist) {
    const re = new RegExp(allowlist);
    if (!re.test(trimmed)) {
      throw new Error("Command blocked: does not match TOOL_SHELL_ALLOWLIST_REGEX");
    }
  }

  const cwd = process.env.TOOL_SHELL_CWD?.trim() || process.cwd();
  const timeoutMs = parsePositiveInt(process.env.TOOL_SHELL_TIMEOUT_MS, 60_000);
  const maxBytes = parsePositiveInt(process.env.TOOL_SHELL_MAX_OUTPUT_BYTES, 131_072);

  return new Promise((resolve, reject) => {
    const child = spawn(trimmed, {
      shell: true,
      cwd,
      env: process.env,
      windowsHide: true,
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1000).unref?.();
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const stdoutS = child.stdout ?? Readable.from([]);
    const stderrS = child.stderr ?? Readable.from([]);
    const stdoutP = drainLimited(stdoutS, maxBytes);
    const stderrP = drainLimited(stderrS, maxBytes);

    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      void Promise.all([stdoutP, stderrP])
        .then(([out, err]) => {
          const parts = [
            `exit_code: ${code ?? "null"}`,
            signal ? `signal: ${signal}` : "",
            "",
            "--- stdout ---",
            out.text + (out.truncated ? "\n[stdout truncated]" : ""),
            "",
            "--- stderr ---",
            err.text + (err.truncated ? "\n[stderr truncated]" : ""),
          ].filter(Boolean);
          resolve(parts.join("\n"));
        })
        .catch(reject);
    });
  });
}
