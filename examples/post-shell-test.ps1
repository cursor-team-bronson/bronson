# Test shell tool + optional file on disk (see shell-write-local.yaml).
#
# 1. In apps/orchestrator/.env set:
#      ALLOW_SHELL_TOOL=true
#    Optional — where bronson-shell-proof.txt is created (orchestrator host paths):
#      TOOL_SHELL_CWD=C:\Users\julie\bronson\examples
#
# 2. Restart: npm run dev -w @bronson/orchestrator
#
# 3. From repo root:
#      .\examples\post-shell-test.ps1
#
# The text file is written by cmd ON THE SERVER (the machine running Node), not inside your browser.
# If you omit TOOL_SHELL_CWD, the file lands next to wherever the orchestrator process cwd is
# (often apps/orchestrator when using npm run dev -w).

param(
    [string] $OrchestratorUrl = "http://127.0.0.1:3001",
    [string] $OutLog = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$yamlPath = Join-Path $PSScriptRoot "shell-write-local.yaml"
if (-not (Test-Path -LiteralPath $yamlPath)) {
    throw "Missing $yamlPath"
}

$yaml = [string] (Get-Content -LiteralPath $yamlPath -Raw)
$body = @{ yaml = $yaml } | ConvertTo-Json -Depth 10 -Compress

Write-Host "POST /api/runs (shell-write-local.yaml)..." -ForegroundColor Cyan
$response = Invoke-RestMethod -Uri "$OrchestratorUrl/api/runs" -Method POST -Body $body -ContentType "application/json; charset=utf-8"
$response | Format-List

$runId = $response.runId
$jobId = "write_proof"
$deadline = (Get-Date).AddMinutes(3)

Write-Host "`nWaiting for job '$jobId'..." -ForegroundColor Cyan
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $events = @(Invoke-RestMethod -Uri "$OrchestratorUrl/api/runs/$runId/events/history")
    $done = $events | Where-Object { $_.jobId -eq $jobId -and $_.type -eq "JOB_COMPLETED" } | Select-Object -Last 1
    if ($done) {
        Write-Host "Job completed." -ForegroundColor Green
        if ($OutLog) {
            $fullPath = if ([System.IO.Path]::IsPathRooted($OutLog)) { $OutLog } else { Join-Path $repoRoot $OutLog }
            Set-Content -LiteralPath $fullPath -Value ([string]$done.payload.output) -Encoding utf8
            Write-Host "Saved agent reply to: $fullPath" -ForegroundColor Green
        }
        Write-Host "`nLook for bronson-shell-proof.txt on the orchestrator machine under TOOL_SHELL_CWD (or orchestrator cwd)." -ForegroundColor Yellow
        Write-Host "Tip: set TOOL_SHELL_CWD in apps/orchestrator/.env to e.g. $repoRoot\examples" -ForegroundColor Yellow
        exit 0
    }
    $failed = $events | Where-Object { $_.type -eq "RUN_FAILED" -or ($_.jobId -eq $jobId -and $_.type -eq "JOB_FAILED") }
    if ($failed) {
        throw "Run failed: $($failed | ConvertTo-Json -Compress)"
    }
}

throw "Timed out waiting for job (run $runId)."
