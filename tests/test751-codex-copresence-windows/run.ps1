$ErrorActionPreference = "Stop"
$report = Join-Path $env:RUNNER_TEMP "report-test751-windows.txt"
Set-Location (Join-Path $PSScriptRoot "..\..\agent-network")
@("# test751 — native Windows Codex co-presence", "date: $([DateTime]::UtcNow.ToString('o'))") | Set-Content $report
bun install --frozen-lockfile 2>&1 | Tee-Object -FilePath $report -Append
bun test src/copresence-deps.test.ts src/windows-codex-copresence.test.ts src/codex-copresence-thread.test.ts 2>&1 | Tee-Object -FilePath $report -Append
bun run typecheck 2>&1 | Tee-Object -FilePath $report -Append
