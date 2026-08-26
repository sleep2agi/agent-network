$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$artifacts = Join-Path $env:RUNNER_TEMP "test1212-artifacts"
$privateRoot = Join-Path $env:RUNNER_TEMP ("test1212-private-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $artifacts, $privateRoot | Out-Null
$acl = Get-Acl $privateRoot
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
$acl.SetAccessRule($rule)
Set-Acl $privateRoot $acl

try {
  if (-not $env:ANET_CODEX_AUTH_JSON) { throw "CODEX_AUTH_JSON protected-environment secret is absent; fail closed" }
  if ($env:ANET_CODEX_AUTH_JSON.Length -gt 1048576) { throw "credential payload unexpectedly large" }
  $null = $env:ANET_CODEX_AUTH_JSON | ConvertFrom-Json
  $source = (git -C $repo rev-parse HEAD).Trim()
  if ($source -ne $env:ANET_EXPECTED_SOURCE_SHA) { throw "source SHA changed after approval" }

  $env:HOME = Join-Path $privateRoot "home"
  $env:USERPROFILE = $env:HOME
  $env:CODEX_HOME = Join-Path $env:HOME ".codex"
  New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
  [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME "auth.json"), $env:ANET_CODEX_AUTH_JSON, (New-Object Text.UTF8Encoding($false)))
  Remove-Item Env:ANET_CODEX_AUTH_JSON

  $codexInstall = Join-Path $privateRoot "codex-0.148.0"
  npm install --prefix $codexInstall --ignore-scripts --no-audit --no-fund --save-exact "@openai/codex@0.148.0"
  if ($LASTEXITCODE -ne 0) { throw "could not install exact Codex package" }
  $codexCmd = Join-Path $codexInstall "node_modules\.bin\codex.cmd"
  $codexVersion = (& $codexCmd --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $codexVersion -ne "codex-cli 0.148.0") { throw "required codex-cli 0.148.0 unavailable" }
  $launcher = Join-Path $codexInstall "node_modules\@openai\codex\bin\codex.js"
  $vendor = Get-ChildItem (Join-Path $codexInstall "node_modules\@openai") -Recurse -File |
    Where-Object { $_.Name -eq "codex.exe" } | Select-Object -First 1
  if (-not (Test-Path $launcher) -or -not $vendor) { throw "Codex launcher/vendor binary missing" }
  $env:ANET_TEST1212_CODEX = $codexCmd
  $env:ANET_TEST1212_LAUNCHER_SHA256 = (Get-FileHash -Algorithm SHA256 $launcher).Hash.ToLowerInvariant()
  $env:ANET_TEST1212_VENDOR_SHA256 = (Get-FileHash -Algorithm SHA256 $vendor.FullName).Hash.ToLowerInvariant()
  $env:ANET_TEST1212_PRIVATE = $privateRoot
  $env:ANET_TEST1212_ARTIFACTS = $artifacts

  Push-Location (Join-Path $repo "agent-network")
  bun install --frozen-lockfile
  Pop-Location
  Push-Location (Join-Path $repo "agent-node")
  bun install --frozen-lockfile
  bun run build
  Pop-Location
  Push-Location (Join-Path $repo "server")
  bun install --frozen-lockfile
  Pop-Location
  node (Join-Path $PSScriptRoot "windows-real-e2e.mjs")
  if ($LASTEXITCODE -ne 0) { throw "real Windows journey failed" }
} catch {
  @{ schema = "anet/windows-real-codex-gate/v1"; result = "FAIL"; sourceSha = $env:ANET_EXPECTED_SOURCE_SHA; notInCi = $true; reason = "protected gate failed closed; inspect runner locally (raw logs are never artifacts)" } |
    ConvertTo-Json | Set-Content (Join-Path $artifacts "result.json")
  throw
} finally {
  Remove-Item Env:ANET_TEST1212_CODEX -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $privateRoot -Recurse -Force -ErrorAction SilentlyContinue
}
