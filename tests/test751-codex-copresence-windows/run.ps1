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
bun test src/copresence-deps.test.ts src/windows-codex-copresence.test.ts src/codex-copresence-thread.test.ts src/windows-stop-identity.test.ts 2>&1 | Tee-Object -FilePath $report -Append
# #1335 —— 这一行的退出码此前**没有被检查**(`| Tee-Object` 之后没有任何判定),会让新见证的红被后面命令的退出码覆盖。显式判定:
if ($LASTEXITCODE -ne 0) { throw "Codex co-presence unit tests failed" }
bun run typecheck 2>&1 | Tee-Object -FilePath $report -Append
# 与上行同理：typecheck 的退出码此前也没有判定，类型错误会被后续命令的退出码掩盖。
if ($LASTEXITCODE -ne 0) { throw "agent-network typecheck failed" }
Set-Location (Join-Path $PSScriptRoot "..\..\agent-node")
bun install --frozen-lockfile 2>&1 | Tee-Object -FilePath $report -Append
bun run build 2>&1 | Tee-Object -FilePath $report -Append
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
  bun test ./agent-node/src/runtime/codex-health.test.ts ./agent-node/src/runtime/windows-tui-health.test.ts 2>&1 | Tee-Object -FilePath $report -Append
  if ($LASTEXITCODE -ne 0) { throw "Codex health regression failed" }
  # #1337 —— 纯测试夹具：现场确认编译器、编译真实 .exe 包装器并证明命中（失败即抛具体障碍）。
  & (Join-Path $PSScriptRoot "compile-shims.ps1") 2>&1 | Tee-Object -FilePath $report -Append
  if ($LASTEXITCODE -ne 0) { throw "test1337 shim compile failed" }
  $shimEnvFile = Join-Path $env:RUNNER_TEMP "anet-test1337-shim-env.ps1"
  if (-not (Test-Path $shimEnvFile)) { throw "test1337 BLOCKER: shim env file missing" }
  . $shimEnvFile
  node ./tests/test751-codex-copresence-windows/windows-e2e.mjs 2>&1 | Tee-Object -FilePath $report -Append
  if ($LASTEXITCODE -ne 0) { throw "Windows native E2E failed" }
} finally {
  Stop-Process -Id $hub.Id -Force -ErrorAction SilentlyContinue
}
