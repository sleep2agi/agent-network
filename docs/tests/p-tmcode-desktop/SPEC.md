# tmcode Desktop 1.18.11 — Windows release-grade test plan

**Owner:** 通信测试马 (test spec + report)
**CI implementer:** 通信SDK马 (PowerShell + matrix in `desktop-build.yml`)
**Real-machine sourcer:** 通信龙 / Vincent
**Target:** [`tmcode-Setup-1.18.11-x64.exe`](https://github.com/tianma-ai/tmcode/releases/download/desktop-v1.18.11/tmcode-Setup-1.18.11-x64.exe) (130MB, prerelease, unsigned MVP-A)
**Test date:** 2026-06-15

## What 1.18.11 specifically fixed (vs 1.18.10 / earlier)

1. xdg-open crash guard (Electron main → no spawn-xdg on Windows)
2. `TMCODE_SERVER_PASSWORD` actually enforced (server auth path on Windows)
3. TM logo + de-brand (no "OpenCode" in HTML / window / favicon)

→ Tests must positively verify all three are working on real Windows.

## Test matrix (28 cases)

Convention:
- **Verdict format**: `PASS` / `FAIL` / `WARN` / `SKIP-real-machine`
- **PowerShell snippets**: SDK马 inlines into `desktop-build.yml` `smoke` job (or new `release-smoke` job for the matrix variants)
- **Matrix axes**: `os: [windows-latest, windows-2019]` (the latter is the existing-fleet gap)
- **Artifacts to attach per run**: install.log, all process logs, screenshots, registry snapshots, uninstall.log

---

### Block A — Install (5 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **A1** | Silent install `/S` exits 0 | `Start-Process -ArgumentList "/S" -Wait`, then `$LASTEXITCODE -eq 0`; install log clean (no `ERR_/FATAL/access denied`) | ✅ existing |
| **A2** | Per-user install location (not admin) | Files land at `$env:LOCALAPPDATA\Programs\tmcode`; **NEGATIVE assert**: `Test-Path $env:ProgramFiles\tmcode -eq $false` (must NOT be elevated) | ✅ add neg-assert |
| **A3** | File layout complete | Every required file present: `tmcode.exe` (Electron wrapper, ≥ 100MB), `resources\bin\tmcode.exe` (bundled CLI, ≥ 80MB), `Uninstall*.exe`, `resources\app.asar`, `resources\app.asar.unpacked` (if any) | ✅ extend existing |
| **A4** | Shortcut creation | Start Menu shortcut at `$env:APPDATA\Microsoft\Windows\Start Menu\Programs\tmcode\tmcode.lnk` exists + points to install dir's Electron exe | ✅ add |
| **A5** | Double-click interactive install UX | NSIS wizard renders, Next/Install/Finish flow, user-visible progress bar | ❌ real-machine |

### Block B — Launch (5 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **B1** | Bundled CLI cold start | `tmcode.exe web` spawns; port-up within 30s; HTTP 200 on `/` | ✅ existing |
| **B2** | Electron wrapper cold start | `tmcode.exe` (wrapper) spawns + survives 20s + spawns child bun on port 4096-4200 + HTTP 200 from child | ⚠ existing (best-effort), upgrade to required-PASS on `windows-latest` (1.18.11 fixed crash) |
| **B3** | TM logo in HTML (de-brand) | `(Invoke-WebRequest /).Content -match '<title>tmcode</title>'` AND `opencode count == 0` AND `favicon` reference present | ✅ existing |
| **B4** | Window title is "tmcode" (electron BrowserWindow) | Via `Get-Process tmcode | Select MainWindowTitle` — must contain "tmcode" (case-insensitive); must NOT contain "OpenCode" / "Electron" | ✅ add |
| **B5** | Real screenshot — TM logo visible | Capture Electron HWND via `Add-Type` PrintWindow → PNG artifact; human review on `windows-latest` artifact tab | ✅ partial (capture in CI, visual verify human-reviewed) |

### Block C — Use / Functional (4 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **C1** | Configure model + API key via UI | User enters key in settings panel, saved to disk, persists across restart | ❌ real-machine (UI typing + reload) |
| **C2** | Send message → receive reply | Full LLM round-trip with real API key; response renders in chat | ❌ real-machine (needs real key) |
| **C3** | File upload + render in chat | Attach .txt/.md, content displays correctly | ❌ real-machine |
| **C4** | Image upload + render | Attach .png/.jpg, image displays | ❌ real-machine |

### Block D — Logo / Branding (3 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **D1** | favicon.ico served | `Invoke-WebRequest http://.../favicon.ico` returns 200 + content-type image/x-icon (or image/png); body bytes ≠ 0 | ✅ add |
| **D2** | Window title `tmcode` | Already in B4 | (see B4) |
| **D3** | Taskbar icon visual | TM logo visible in Windows taskbar | ❌ real-machine (visual) |

### Block E — Lifecycle (5 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **E1** | Graceful shutdown — no zombie tmcode.exe | After `Stop-Process` on Electron wrapper, wait 5s, `(Get-Process tmcode -ErrorAction SilentlyContinue).Count -eq 0` | ✅ add |
| **E2** | Graceful shutdown — no zombie bun children | After E1, `Get-Process bun -ErrorAction SilentlyContinue` is empty OR only contains pre-existing CI bun (capture baseline) | ✅ add |
| **E3** | Warm restart | After E1+E2, re-launch Electron wrapper, B2 + B3 pass again | ✅ add |
| **E4** | Silent uninstall `/S` exits 0 | `Start-Process Uninstall.exe -ArgumentList "/S" -Wait` → exit 0 | ✅ existing |
| **E5** | Install-uninstall-install cycle | A1 → E4 → A1 → B1 — second install lands clean (no permission errors from leftover files) | ✅ add |

### Block F — Uninstall residue (3 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **F1** | Install dir removed | After E4, `Test-Path $env:LOCALAPPDATA\Programs\tmcode -eq $false` | ✅ add |
| **F2** | Start Menu shortcut removed | After E4, A4's shortcut path no longer exists | ✅ add |
| **F3** | Registry uninstall key removed | After E4, `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where DisplayName -like 'tmcode*'` returns empty | ✅ add |

### Block G — Compat matrix (2 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **G1** | windows-latest (Server 2022) | All ✅-marked cases above PASS | ✅ existing runner |
| **G2** | windows-2019 (Server 2019) | All ✅-marked cases above PASS — confirms older NSIS / .NET 4.x compatibility | ✅ add matrix axis |
| **G3** | Windows 10 client (real desktop) | A5 + B5 visual + C1-C4 + D3 — all real-machine | ❌ real-machine |
| **G4** | Windows 11 client | Same as G3 | ❌ real-machine |

### Block H — Security (3 cases)

| # | Case | Acceptance | CI? |
|---|---|---|---|
| **H1** | Windows Defender real-time scan | After install, `Get-MpThreatDetection` returns empty; install dir not quarantined | ✅ add |
| **H2** | SmartScreen first-download popup | User downloads from GitHub, double-clicks → SmartScreen warning shown → "More info / Run anyway" path works | ❌ real-machine (browser reputation + interactive) |
| **H3** | `TMCODE_SERVER_PASSWORD` enforces 401 unauthed | Already in B-tier existing CI | (existing) |

---

## CI summary

**Automatable in CI (windows-latest + windows-2019 matrix):** ~20 cases
- A1, A2, A3, A4
- B1, B2, B3, B4, B5 (capture only — visual verify human-reviewed via artifact)
- D1
- E1, E2, E3, E4, E5
- F1, F2, F3
- G1, G2
- H1, H3

**Real-machine only:** ~8 cases — A5, B5 visual confirm, C1, C2, C3, C4, D3, G3, G4, H2

---

## Hand-off to SDK马

PowerShell snippets for new cases (existing yml shows the style, these slot in):

### A2 — per-user negative assert
```powershell
$adminPath = Join-Path $env:ProgramFiles "tmcode"
if (Test-Path $adminPath) {
  Write-Error "A2 FAIL: installer landed in admin path $adminPath"; exit 1
}
Write-Host "✓ A2 — no admin install"
```

### A4 — Start Menu shortcut
```powershell
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\tmcode\tmcode.lnk"
if (-not (Test-Path $lnk)) {
  Write-Error "A4 FAIL: Start Menu shortcut missing: $lnk"; exit 1
}
$wsh = New-Object -ComObject WScript.Shell
$target = $wsh.CreateShortcut($lnk).TargetPath
if ($target -notlike "*\tmcode\*tmcode.exe") {
  Write-Error "A4 FAIL: shortcut target unexpected: $target"; exit 1
}
Write-Host "✓ A4 — Start Menu shortcut OK ($target)"
```

### B4 — Electron window title (after B2 launch)
```powershell
$proc = Get-Process tmcode -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | Select-Object -First 1
if (-not $proc) {
  Write-Host "⚠ B4 SKIP: no Electron with MainWindowTitle (CI may lack interactive session)"
} elseif ($proc.MainWindowTitle -notmatch "tmcode") {
  Write-Error "B4 FAIL: window title is '$($proc.MainWindowTitle)' — expected to contain 'tmcode'"; exit 1
} elseif ($proc.MainWindowTitle -match "OpenCode") {
  Write-Error "B4 FAIL: window title contains 'OpenCode' — de-brand regression"; exit 1
} else {
  Write-Host "✓ B4 — window title: $($proc.MainWindowTitle)"
}
```

### B5 — Electron screenshot
```powershell
Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class ScreenCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@ -ReferencedAssemblies System.Drawing
$proc = Get-Process tmcode | Where-Object MainWindowTitle | Select-Object -First 1
if (-not $proc) { Write-Host "⚠ B5 SKIP: no Electron HWND"; exit 0 }
$hwnd = $proc.MainWindowHandle
$rect = New-Object ScreenCap+RECT
[ScreenCap]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.R - $rect.L; $h = $rect.B - $rect.T
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[ScreenCap]::PrintWindow($hwnd, $hdc, 0) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save("$env:GITHUB_WORKSPACE\tmcode-electron-window.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "✓ B5 — screenshot saved: tmcode-electron-window.png"
```

### D1 — favicon HTTP probe
```powershell
$r = Invoke-WebRequest "http://127.0.0.1:$port/favicon.ico" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
if ($r.StatusCode -ne 200) { Write-Error "D1 FAIL: favicon HTTP $($r.StatusCode)"; exit 1 }
if ($r.RawContentLength -le 0) { Write-Error "D1 FAIL: favicon body empty"; exit 1 }
Write-Host "✓ D1 — favicon $($r.RawContentLength) bytes"
```

### E1 + E2 — zombie check
```powershell
Stop-Process -Id $electronPid -Force
Start-Sleep -Seconds 5
$tmcZombies = @(Get-Process tmcode -ErrorAction SilentlyContinue)
$bunZombies = @(Get-Process bun -ErrorAction SilentlyContinue | Where-Object Id -ne $ciBunBaselinePid)
if ($tmcZombies.Count -gt 0) {
  Write-Error "E1 FAIL: $($tmcZombies.Count) tmcode zombies: $($tmcZombies | Format-Table | Out-String)"; exit 1
}
if ($bunZombies.Count -gt 0) {
  Write-Error "E2 FAIL: $($bunZombies.Count) bun zombies"; exit 1
}
Write-Host "✓ E1/E2 — clean shutdown, no zombies"
```

### E5 — install-uninstall-install cycle (regression: leftover .pid / DB lock)
```powershell
# Cycle 1: install → uninstall (existing flow)
# Cycle 2: re-install → verify A1+A3 again
Write-Host "Re-install cycle..."
$p2 = Start-Process -FilePath $exe.FullName -ArgumentList "/S" -PassThru -Wait
if ($p2.ExitCode -ne 0) { Write-Error "E5 FAIL: re-install rc=$($p2.ExitCode)"; exit 1 }
if (-not (Test-Path $electron)) { Write-Error "E5 FAIL: Electron exe missing after re-install"; exit 1 }
Write-Host "✓ E5 — re-install clean"
```

### F1/F2/F3 — uninstall residue
```powershell
# After E4 uninstall completes:
if (Test-Path $base) { Write-Error "F1 FAIL: install dir lingers: $base"; exit 1 }
Write-Host "✓ F1 — install dir gone"

if (Test-Path $lnk) { Write-Error "F2 FAIL: Start Menu shortcut lingers: $lnk"; exit 1 }
$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\tmcode"
if (Test-Path $startMenuDir) {
  Write-Host "⚠ F2 partial: parent dir still exists (may be acceptable if empty)"
  $contents = Get-ChildItem $startMenuDir -ErrorAction SilentlyContinue
  if ($contents) { Write-Error "F2 FAIL: dir not empty"; exit 1 }
}
Write-Host "✓ F2 — shortcut removed"

$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'tmcode*' }
if ($reg) { Write-Error "F3 FAIL: registry uninstall key lingers: $($reg.PSPath)"; exit 1 }
Write-Host "✓ F3 — registry clean"
```

### G2 — matrix axis
```yaml
# In desktop-build.yml smoke job:
smoke:
  strategy:
    matrix:
      os: [windows-latest, windows-2019]
    fail-fast: false
  runs-on: ${{ matrix.os }}
  # ... rest unchanged
```

### H1 — Defender threat scan
```powershell
$threats = Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object Resources -match "tmcode"
if ($threats) {
  Write-Error "H1 FAIL: Defender flagged tmcode: $($threats | Format-Table | Out-String)"; exit 1
}
$quar = Get-MpThreat -ErrorAction SilentlyContinue | Where-Object Resources -match "tmcode"
if ($quar) { Write-Error "H1 FAIL: tmcode in quarantine"; exit 1 }
Write-Host "✓ H1 — Defender clean"
```

---

## Artifact upload (per matrix axis)

```yaml
- name: Upload test artifacts
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: tmcode-desktop-test-${{ matrix.os }}
    path: |
      desktop/install.log
      desktop/tmcode-out*.log
      desktop/tmcode-err*.log
      desktop/electron-out.log
      desktop/electron-err.log
      desktop/tmcode-electron-window.png
      desktop/*.png
    retention-days: 14
```

---

## ETA

- Spec authoring (this doc): **done** (~60min)
- SDK马 CI implementation (~14 new PowerShell case snippets + matrix axis + artifact upload): **60-90min**
- Run + my review of artifacts (per-case verdict): **30-45min**
- Final report on issue: **30min**

**Total clock: ~3h from now → final report on `tmcode#8`.**

---

## Real-machine gap list (for 通信龙 / Vincent)

CI cannot cover these; need actual Win10/11 client desktop:

| # | What | Why CI can't |
|---|---|---|
| A5 | Explorer double-click NSIS wizard UX | CI runner has no interactive Explorer |
| B5 visual | TM logo pixel-level verify | CI may render headless / different DPI |
| C1-C4 | Real LLM key + UI typing + chat round-trip | needs real human + key |
| D3 | Taskbar pin / icon | needs interactive desktop session |
| G3, G4 | Win 10 / 11 client | CI is Server 2019/2022 |
| H2 | SmartScreen popup | needs browser download path + interactive prompt |

Recommend Vincent does these in a **single 15-min real-machine session** after CI matrix passes:
1. Download .exe from GitHub release (capture SmartScreen behavior)
2. Double-click → NSIS wizard → install
3. Open from Start Menu → verify taskbar icon + window title visually
4. Configure key + send 1 test message
5. Drop a .txt + .png attachment
6. Quit + verify cleanup via Task Manager

Net real-machine time: ~15min. Net CI run: ~10-15min × 2 OS = ~30min.

---

🤖 Author: 通信测试马 · For: tianma-ai/tmcode#8 · Co-impl: 通信SDK马
