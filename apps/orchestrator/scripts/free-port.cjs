"use strict";

/**
 * Dev helper: stop any process listening on PORT (default 3001) so `tsx watch` can bind.
 * Does not run for `npm start` / production.
 *
 * Opt out: BRONSON_SKIP_FREE_PORT=1
 */

const { execFileSync } = require("child_process");

const port = Number(process.env.PORT) || 3001;

if (process.env.BRONSON_SKIP_FREE_PORT === "1") {
  process.exit(0);
}

function killWindows() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { $p | Sort-Object -Unique }`,
      ],
      { encoding: "utf8" },
    );
    const pids = [
      ...new Set(
        out
          .trim()
          .split(/\r?\n/)
          .map((l) => parseInt(l.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    for (const pid of pids) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { stdio: "pipe" });
        console.error(`[bronson] Freed port ${port}: stopped PID ${pid}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no listener or powershell failed */
  }
}

function killUnix() {
  try {
    const out = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
    const pids = [
      ...new Set(
        out
          .trim()
          .split("\n")
          .map((l) => parseInt(l.trim(), 10))
          .filter((n) => n > 0),
      ),
    ];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        console.error(`[bronson] Freed port ${port}: stopped PID ${pid}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* no listener or lsof missing */
  }
}

if (process.platform === "win32") killWindows();
else killUnix();
