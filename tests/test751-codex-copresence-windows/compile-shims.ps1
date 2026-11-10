# #1337 —— 现场确认编译器与真实程序路径，编译纯测试夹具，并**证明命中**（命中必须有调用日志见证）。
#
# 纪律：找不到编译器 / 包装器未被命中 ⇒ **抛出具体障碍**（不静默跳过、不为凑绿改产品）。
param([string]$OutDir = (Join-Path $env:RUNNER_TEMP "anet-test1337-shim"))
$ErrorActionPreference = "Stop"

# 1) 编译器：现场确认
$cscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  $found = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($found) { $csc = $found.Source }
}
if (-not $csc) { throw "test1337 BLOCKER: 未找到 C# 编译器 csc.exe，无法在现场编译真实 .exe 包装器" }
Write-Host "test1337: compiler = $csc"

# 2) 真实程序绝对路径（包装器委托用）
$realPs = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
$realTk = Join-Path $env:WINDIR "System32\taskkill.exe"
if (-not (Test-Path $realTk)) { throw "test1337 BLOCKER: 未找到 $realTk" }
Write-Host "test1337: real powershell = $realPs"
Write-Host "test1337: real taskkill  = $realTk"

# 3) 编译（真 .exe；`.cmd` 不是替身）
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
& $csc /nologo /target:exe /out:"$OutDir\powershell.exe" (Join-Path $PSScriptRoot "shim\PowerShellShim.cs")
if ($LASTEXITCODE -ne 0) { throw "test1337 BLOCKER: PowerShellShim 编译失败 rc=$LASTEXITCODE" }
& $csc /nologo /target:exe /out:"$OutDir\taskkill.exe" (Join-Path $PSScriptRoot "shim\TaskkillShim.cs")
if ($LASTEXITCODE -ne 0) { throw "test1337 BLOCKER: TaskkillShim 编译失败 rc=$LASTEXITCODE" }

# 4) 证明命中：以具名模式跑一次，要求输出与调用日志同时出现
$log = Join-Path $env:RUNNER_TEMP "anet-test1337-ps.log"
Remove-Item $log -ErrorAction SilentlyContinue
$env:ANET_TEST1337_PS_LOG = $log
$env:ANET_TEST1337_PS_MODE = "illegal-identity"
$env:ANET_TEST1337_REAL_POWERSHELL = $realPs
# 🔴 命中探针必须用**真实新身份协议的形状**（包装器的注入条件要求同时含 `CIMSTATE:` 与 `Get-CimInstance`）——
#    否则探针会被**委托**给真实程序，等于没验证注入路径。
$newShape = "`$p=Get-CimInstance Win32_Process|Select-Object -First 1;'CIMSTATE:CREATED='+`$(`$p.CreationDate.ToString('o'))"
$probeNew = & "$OutDir\powershell.exe" -NoProfile -Command $newShape
if ($probeNew -notmatch "CIMSTATE:CREATED=not-a-date") { throw "test1337 BLOCKER: 包装器未被命中（新协议形状探针输出=$probeNew）" }

# 🔴 非放宽探针：**旧 ownership 形状**（既不含 CIMSTATE: 也不含 Get-CimInstance）必须被**委托**给真实程序，
#    输出应是真实 ticks（纯数字）——证明夹具没有把拦截放宽到旧的 ownership 查询。
$oldShape = "[Diagnostics.Process]::GetProcessById($PID).StartTime.ToUniversalTime().Ticks.ToString()"
$probeOld = & "$OutDir\powershell.exe" -NoProfile -Command $oldShape
if ($probeOld -notmatch "^\d+$") { throw "test1337 BLOCKER: 拦截被放宽到旧 ownership 查询（输出=$probeOld）" }

if (-not (Test-Path $log)) { throw "test1337 BLOCKER: 包装器命中但无调用日志" }
$logText = Get-Content $log -Raw
if ($logText -notmatch "illegal-identity\t.*CIMSTATE:") { throw "test1337 BLOCKER: 调用日志里没有新协议查询的命中记录" }
if ($logText -notmatch "illegal-identity\t.*GetProcessById") { throw "test1337 BLOCKER: 调用日志里没有旧 ownership 查询的委托记录" }
Write-Host "test1337: shim hit proven by new-protocol probe + old-ownership delegated (call log)"

# 5) 供后续步骤使用（写文件而非改全局环境）
$envFile = Join-Path $env:RUNNER_TEMP "anet-test1337-shim-env.ps1"
@(
  "`$env:ANET_TEST1337_SHIM_DIR = '$OutDir'",
  "`$env:ANET_TEST1337_REAL_POWERSHELL = '$realPs'",
  "`$env:ANET_TEST1337_REAL_TASKKILL = '$realTk'"
) | Set-Content -Path $envFile -Encoding utf8
Write-Host "test1337: shim dir = $OutDir"
