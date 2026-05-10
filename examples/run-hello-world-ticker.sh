#!/usr/bin/env bash
# Loads hello-world-ticker.yaml, bumps RunCount each loop, POSTs every 2 minutes, appends output to hello-world-ticker.out.txt
#
# Requires: curl, jq (macOS: brew install jq), orchestrator reachable (default http://127.0.0.1:3001), CLOD_API_KEY for the orchestrator.
#
# Usage:
#   chmod +x run-hello-world-ticker.sh
#   ./run-hello-world-ticker.sh
#
# Env:
#   ORCHESTRATOR_URL   (default http://127.0.0.1:3001)
#   YAML_FILE          (default: hello-world-ticker.yaml next to this script)
#   OUT_FILE           (default: hello-world-ticker.out.txt next to this script)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://127.0.0.1:3001}"
YAML_FILE="${YAML_FILE:-$SCRIPT_DIR/hello-world-ticker.yaml}"
OUT_FILE="${OUT_FILE:-$SCRIPT_DIR/hello-world-ticker.out.txt}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required (macOS: brew install jq)" >&2; exit 1; }

n=0
while true; do
  n=$((n + 1))

  yaml_body="$(sed -E 's/Line 3: RunCount:[[:space:]]*[0-9]+/Line 3: RunCount: '"$n"'/' "$YAML_FILE")"
  json_payload="$(jq -n --arg yaml "$yaml_body" '{yaml: $yaml}')"

  response="$(curl -sS -X POST "$ORCHESTRATOR_URL/api/runs" \
    -H "Content-Type: application/json" \
    -d "$json_payload")"

  run_id="$(echo "$response" | jq -r '.runId // empty')"
  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    echo "POST /api/runs failed: $response" >&2
    exit 1
  fi

  output=""
  for _ in $(seq 1 120); do
    sleep 1
    events="$(curl -sS "$ORCHESTRATOR_URL/api/runs/$run_id/events/history")"

    if echo "$events" | jq -e 'map(select(.type == "RUN_FAILED")) | length > 0' >/dev/null 2>&1; then
      echo "Run failed (RUN_FAILED): $events" >&2
      exit 1
    fi
    if echo "$events" | jq -e 'map(select(.jobId == "emit_status" and .type == "JOB_FAILED")) | length > 0' >/dev/null 2>&1; then
      echo "Run failed (JOB_FAILED): $events" >&2
      exit 1
    fi

    output="$(echo "$events" | jq -r '.[] | select(.jobId == "emit_status" and .type == "JOB_COMPLETED") | .payload.output' | tail -n 1)"
    if [[ -n "$output" && "$output" != "null" ]]; then
      break
    fi
  done

  if [[ -z "$output" ]]; then
    echo "Timeout waiting for emit_status JOB_COMPLETED" >&2
    exit 1
  fi

  stamp="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  {
    echo "--- $stamp (run $n) ---"
    echo "$output"
    echo ""
  } >> "$OUT_FILE"

  echo "[$stamp] run $n -> $OUT_FILE"
  sleep 120
done
