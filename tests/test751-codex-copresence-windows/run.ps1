$ErrorActionPreference = "Stop"
$report = Join-Path $env:RUNNER_TEMP "report-test751-windows.txt"
Set-Location (Join-Path $PSScriptRoot "..\..\agent-network")
@("# test751 — native Windows Codex co-presence", "date: $([DateTime]::UtcNow.ToString('o'))") | Set-Content $report
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$fakeCodex = Join-Path $repoRoot "tests\test751-codex-copresence-windows\fake-codex.mjs"
$sourceCommit = (git -C $repoRoot rev-parse HEAD).Trim()
$fakeHash = (Get-FileHash -Algorithm SHA256 $fakeCodex).Hash.ToLowerInvariant()
$threadReadWire = (Select-String -Path $fakeCodex -SimpleMatch 'msg.method === "thread/read"').Line.Trim()
@("source_commit: $sourceCommit", "fake_codex_sha256: $fakeHash", "fake_thread_read_wire: $threadReadWire") | Tee-Object -FilePath $report -Append
bun install --frozen-lockfile 2>&1 | Tee-Object -FilePath $report -Append
bun test src/copresence-deps.test.ts src/windows-codex-copresence.test.ts src/codex-copresence-thread.test.ts 2>&1 | Tee-Object -FilePath $report -Append
bun run typecheck 2>&1 | Tee-Object -FilePath $report -Append
Set-Location (Join-Path $PSScriptRoot "..\..\server")
bun install --frozen-lockfile 2>&1 | Tee-Object -FilePath $report -Append
$env:PORT = "19351"
$env:COMMHUB_AUTH_TOKEN = "test751-server-token"
$hub = Start-Process bun -ArgumentList "run", "src/index.ts" -WorkingDirectory (Get-Location) -PassThru -WindowStyle Hidden
try {
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:19351/health | Out-Null; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if ($i -ge 60) { throw "CommHub did not become healthy" }
  Set-Location (Join-Path $PSScriptRoot "..\..")
  $env:ANET_TEST751_BUN = (Get-Command bun).Source
  node ./tests/test751-codex-copresence-windows/windows-e2e.mjs 2>&1 | Tee-Object -FilePath $report -Append
} finally {
  Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue
}
