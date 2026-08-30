# Mobile and desktop clients

Besides the browser, the Dashboard ships three **client shells**: a PWA, iOS / Android,
and a macOS / Windows / Linux desktop app.

::: warning They do not live in this repository
All three are in **[sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard)**,
not in `sleep2agi/agent-network`. The authoritative document is `docs/mobile-app.md` in that
repository; this page is an entry point and a status note.
:::

## All three are thin shells

They **re-implement nothing**. They put an already-running Dashboard into a window:
authentication, data access, upload and realtime all stay in the Dashboard and CommHub
services. Which means:

- upgrading a shell does not change the permission model;
- once installed, you see exactly the same Dashboard as in a browser;
- **you need a reachable Dashboard URL first**, or the shell has nothing to show.

Desktop and mobile default to `http://127.0.0.1:3000`. A phone is a *different device* — its own
loopback address cannot reach your computer — so for on-device testing set a URL it can reach:

```bash
export ANET_DASHBOARD_URL="https://your-dashboard.example.com"
```

## PWA (the cheapest option)

The Dashboard is already a PWA. Open it over **HTTPS** and the browser (Safari / Chrome on
mobile, Chrome / Edge on desktop) offers "Add to Home Screen" / "Install app".

⚠️ **Plain HTTP will not do** — installability and service workers require a secure context.
`http://127.0.0.1` is the exception (fine for local work); a LAN IP usually is not.

## iOS / Android (Capacitor)

A Capacitor WebView shell pointed at the same Dashboard URL. Requires Xcode (iOS) or
Android Studio (Android). Exact commands are in that repository's `docs/mobile-app.md`.

## Desktop (Electron)

```bash
# inside the agent-network-dashboard repository
npm install
ANET_DASHBOARD_URL=https://dashboard.example.com npm run app:desktop      # run it
npm run app:desktop:pack                                                  # build installers
```

The window shell is a few dozen lines and its security posture is tightened:
`contextIsolation` on, `nodeIntegration` off, `sandbox` on, and external links are handed to
the system browser instead of navigating inside the app.

### 🔴 Packaging status (measured 2026-08-19 — do not go by older impressions)

| Target | Status |
| --- | --- |
| Linux `AppImage` | **Verified to build**, ~194 MB |
| macOS `dmg` / `zip` | Configured, **nobody has verified it on that platform** |
| Windows `nsis` | Configured, **nobody has verified it on that platform** |

Three things worth knowing:

1. **This packaging has never run in that repository's CI** — none of its four workflows
   invoke it. So "it works" currently rests on someone running it by hand; nothing automated
   is guarding it.
2. Before 2026-08-19 it **failed on the very first run**: electron-builder derives the
   executable name from `package.json`'s `name`, and that name contains `@` and `/`.
   Fixed by setting `executableName` explicitly.
3. Installing dependencies downloads a ~100 MB electron binary. That download **has failed in
   CI**, so the first obstacle to wiring packaging into CI is the stability of that download,
   not the configuration.

**Until someone builds them on the matching platform, this page will not claim the macOS or
Windows installers work.**

::: tip That sentence is only about the Dashboard shell
There is a **second, independent client line**:
[`sleep2agi/agent-network-app`](https://github.com/sleep2agi/agent-network-app)
(`desktop/` + `src-tauri/`, Tauri). It has its own packaging pipeline, and **its macOS job runs
on a real `macos-14` runner**, producing a `.dmg` and an `.app` zip. It has succeeded
(most recently 2026-06-17).

So the answer to "is there a Mac installer" is **yes** — just not from the shell this page
describes. Both lines currently coexist; this page does not judge which one is the main line.
See [issue #233](https://github.com/sleep2agi/agent-network/issues/233).

🔴 **Before 2026-08-31 this section claimed "Windows is the one genuinely empty cell across all
three repositories". That is no longer true**, and it contradicted this site's own Windows
download button. The current facts:

| Platform | `agent-network-app` packaging | Evidence |
|---|---|---|
| Windows | **Yes**, built in CI | `desktop-tauri.yml:100` `runs-on: windows-latest`; `:149` `npx tauri build --bundles nsis,msi` |
| Artifacts | `.exe` (nsis) + `.msi` (WiX), each with a `.sig` | `desktop-v0.2.41` ships `Agent.Network_0.2.41_x64-setup.exe` (35 MB) and `_x64_en-US.msi` (48 MB) |

**The Dashboard shell still has no Windows CI** — its `electron-builder.json` does *configure* a
`win: nsis` target, but no CI runs it: **a configured target is not a produced artifact.**
The two facts used to be merged into one sentence, so "the Dashboard shell has none" was read as
"the project has none".
:::

## Which one should I use

- Just want it on your phone → **PWA**, no build step at all;
- Handing it to people who do not use a terminal → **desktop installer** (the `agent-network-app` line produces macOS / Windows artifacts in CI — see the table above; the Dashboard shell is still Linux-only);
- Need system capabilities (push, files, camera) → **Capacitor**, which is what needs Xcode / Android Studio.
