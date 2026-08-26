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
  $credentialJson = $env:ANET_CODEX_AUTH_JSON
  $null = $credentialJson | ConvertFrom-Json
  Remove-Item Env:ANET_CODEX_AUTH_JSON
  $source = (git -C $repo rev-parse HEAD).Trim()
  if ($source -ne $env:ANET_EXPECTED_SOURCE_SHA) { throw "source SHA changed after approval" }

  $env:HOME = Join-Path $privateRoot "home"
  $env:USERPROFILE = $env:HOME
  $env:CODEX_HOME = Join-Path $env:HOME ".codex"
  New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
  $codexInstall = Join-Path $privateRoot "codex-0.148.0"
  npm install --prefix $codexInstall --ignore-scripts --no-audit --no-fund --save-exact "@openai/codex@0.148.0"
  if ($LASTEXITCODE -ne 0) { throw "could not install exact Codex package" }
  $codexCmd = Join-Path $codexInstall "node_modules\.bin\codex.cmd"
  # Static resolution only: no package-controlled script may execute before
  # both the launcher and its one canonical vendor binary are allowlisted.
  $cmdText = Get-Content -LiteralPath $codexCmd -Raw
  $cmdMatches = [regex]::Matches($cmdText, '(?i)%~?dp0\\\.\.\\@openai\\codex\\bin\\codex\.js')
  $cmdTargets = @($cmdMatches | ForEach-Object { $_.Value.ToLowerInvariant().Replace('%~dp0', '%dp0') } | Sort-Object -Unique)
  if ($cmdTargets.Count -ne 1) { throw "codex.cmd does not name one canonical launcher" }
  $launcher = [IO.Path]::GetFullPath((Join-Path (Split-Path $codexCmd) "..\@openai\codex\bin\codex.js"))
  $expectedLauncher = [IO.Path]::GetFullPath((Join-Path $codexInstall "node_modules\@openai\codex\bin\codex.js"))
  if ($launcher -ne $expectedLauncher) { throw "codex.cmd launcher path escaped canonical package root" }
  $vendorPath = [IO.Path]::GetFullPath((Join-Path $codexInstall "node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"))
  $vendorRoot = [IO.Path]::GetFullPath((Join-Path $codexInstall "node_modules\@openai\codex-win32-x64")) + [IO.Path]::DirectorySeparatorChar
  if (-not $vendorPath.StartsWith($vendorRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "vendor path escaped canonical package root" }
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or -not (Test-Path -LiteralPath $vendorPath -PathType Leaf)) { throw "canonical Codex launcher/vendor binary missing" }
  if ((Get-Item -LiteralPath $launcher).LinkType -or (Get-Item -LiteralPath $vendorPath).LinkType) { throw "Codex executable path must not be a link" }
  if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") { throw "allowlist covers only Windows x64" }
  $allowlist = Get-Content (Join-Path $PSScriptRoot "codex-0.148.0-windows-x64-sha256.json") -Raw | ConvertFrom-Json
  $launcherSha = (Get-FileHash -Algorithm SHA256 $launcher).Hash.ToLowerInvariant()
  $vendorSha = (Get-FileHash -Algorithm SHA256 $vendorPath).Hash.ToLowerInvariant()
  if ($allowlist.schema -ne "anet/codex-binary-allowlist/v1" -or
      $allowlist.package -ne "@openai/codex@0.148.0" -or
      $allowlist.platform -ne "win32-x64" -or
      $launcherSha -ne $allowlist.launcherSha256 -or
      $vendorSha -ne $allowlist.vendorSha256) { throw "Codex executable hash is outside trusted allowlist" }
  $codexVersion = (& $codexCmd --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $codexVersion -ne "codex-cli 0.148.0") { throw "required codex-cli 0.148.0 unavailable" }
  # Only materialize auth after every downloaded executable passed the trusted
  # allowlist. npm and its package subprocesses never inherit the credential.
  [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME "auth.json"), $credentialJson, (New-Object Text.UTF8Encoding($false)))
  $credentialJson = $null
  $env:ANET_TEST1212_CODEX = $codexCmd
  $env:ANET_TEST1212_LAUNCHER_SHA256 = $launcherSha
  $env:ANET_TEST1212_VENDOR_SHA256 = $vendorSha
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
