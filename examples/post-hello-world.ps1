# POST examples/hello-world-ticker.yaml to the orchestrator.
# Usage (from repo root):
#   .\examples\post-hello-world.ps1
#   .\examples\post-hello-world.ps1 -OutFile "examples\hello-world-output.txt"
#
# The workflow does not write files by itself — output is in the API/event log.
# Use -OutFile to poll until the job finishes and save the agent text to disk.

param(
    [string] $OrchestratorUrl = "http://127.0.0.1:3001",
    [string] $OutFile = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$yamlPath = Join-Path $PSScriptRoot "hello-world-ticker.yaml"
$yaml = [string] (Get-Content -LiteralPath $yamlPath -Raw)

$body = @{ yaml = $yaml } | ConvertTo-Json -Depth 10 -Compress
$response = Invoke-RestMethod -Uri "$OrchestratorUrl/api/runs" -Method POST -Body $body -ContentType "application/json; charset=utf-8"

$response | Format-List

if (-not $OutFile) {
    Write-Host "`nTip: no file was written. Agent output lives in the event log. To save text to a file, run:" -ForegroundColor DarkYellow
    Write-Host "  .\examples\post-hello-world.ps1 -OutFile `"examples\hello-world-output.txt`"" -ForegroundColor DarkYellow
    exit 0
}

$runId = $response.runId
$jobId = "emit_status"
$deadline = (Get-Date).AddMinutes(3)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $events = @(Invoke-RestMethod -Uri "$OrchestratorUrl/api/runs/$runId/events/history")
    $done = $events | Where-Object { $_.jobId -eq $jobId -and $_.type -eq "JOB_COMPLETED" } | Select-Object -Last 1
    if ($done) {
        $text = [string] $done.payload.output
        $fullPath = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $repoRoot $OutFile }
        $parent = Split-Path -Parent $fullPath
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Set-Content -LiteralPath $fullPath -Value $text -Encoding utf8
        Write-Host "Wrote agent output to: $fullPath" -ForegroundColor Green
        exit 0
    }
    $failed = $events | Where-Object { $_.type -eq "RUN_FAILED" -or ($_.jobId -eq $jobId -and $_.type -eq "JOB_FAILED") }
    if ($failed) {
        throw "Run failed: $($failed | ConvertTo-Json -Compress)"
    }
}

throw "Timed out waiting for job $jobId to complete (run $runId)."
