# Install

This page does one thing: get `anet` installed. Then continue with [Your first node in 10 minutes](/en/guide/getting-started). Already installed? See the [Upgrade Guide](/en/guide/upgrade).

::: tip Prefer not to use a terminal?
The [desktop app](/en/guide/desktop-app) (macOS / Windows) bundles a local Hub, works right after installing, and can set up the local daemon in one click. Downloads are on the [home page](/en/#desktop-download-title).
:::

## Prerequisites: Node.js and Bun {#prerequisites}

| Dependency | Version | How to install |
|---|---|---|
| Node.js | ≥ 22.13.0 | [nvm](https://github.com/nvm-sh/nvm) recommended: `nvm install 22 && nvm use 22`; for Windows see [below](#windows) |
| Bun | ≥ 1.2.0 | `npm install -g bun`, or `curl -fsSL https://bun.sh/install \| bash` |

You need both. The Hub (`commhub-server`) runs on Bun, and `anet hub start` launches it with `bunx`. Without Bun, builds from `2.3.0-preview.47` on stop before launch with `❌ anet hub start requires the Bun runtime`; older builds crash with `Error: spawn bunx ENOENT`.

```bash
node --version       # v22.x or newer
bun --version        # 1.2.x or newer
```

If a global install fails with `EACCES`, use a Node installed by nvm / fnm rather than `sudo npm` or changing system directory permissions.

::: details node / bun not found when started by systemd, cron or another user
nvm only loads in interactive shells, and Bun installs per user into `~/.bun/bin`. To start the Hub and nodes from systemd, cron or another user, `source ~/.nvm/nvm.sh` explicitly in the unit / script and add `~/.bun/bin` to `PATH`, or link node / npm into `/usr/local/bin`.
:::

## Linux / macOS

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

`@sleep2agi/agent-network` provides the `anet` command. `commhub-server` and `agent-node` are fetched automatically on first use; installing `agent-node` up front means the first `anet node start` does not wait for a download.

Verify:

```bash
anet -v
```

`anet -v` shows whether `agent-node` and `commhub-server` are in place and which optional runtime CLIs (`claude`, `codex`, …) are installed. Whenever something fails to start later, look here first.

## Windows {#windows}

Two routes:

- **WSL (Ubuntu)**: a standard Linux environment where every runtime works; the most reliable route. In an administrator PowerShell run `wsl --install`, reboot, open the Ubuntu terminal and follow the Linux steps above. When WSL connects to a Hub on the Windows host, do not use `localhost`; use the host's address as reachable from WSL.
- **Native PowerShell**: `codex-sdk` works as a headless node, and the `codex-cli` co-presence TUI is supported natively; `anet node start` manages the app-server and bridge for you, no tmux needed.

Native PowerShell install:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g bun @sleep2agi/agent-network
npm install -g @openai/codex       # for codex runtimes
anet -v
```

Common Windows problems:

- **`anet --version` fails with `ENOENT ... 'E:\C:\...\package.json'`**: happens when anet is installed on one drive and run from another; fixed in `2.3.0-preview.29` and later. On older versions, switch to the drive anet is installed on first.
- **`spawn codex ENOENT`**: `codex` is not installed, or npm's global bin directory is not on `PATH`.
- **`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after a command finishes**: a Node/libuv cleanup race at process exit; the command itself already took effect. Mostly seen with conda's bundled node; the Node 22 LTS from [nodejs.org](https://nodejs.org) usually fixes it.

## What gets installed {#packages}

| npm package | Command | Purpose |
|---|---|---|
| `@sleep2agi/agent-network` | `anet` | the CLI, which also ships the Client SDK |
| `@sleep2agi/agent-node` | `agent-node` | the node runtime that drives `claude-agent-sdk`, `codex-sdk` and other runtimes |
| `@sleep2agi/commhub-server` | `commhub-server` | the Hub server; needs Bun, and `anet hub start` fetches the matching version automatically |
| `@sleep2agi/agent-network-dashboard` | — | the web Dashboard; `anet hub dashboard` fetches it with `npx` |

Rough sizing: about 256 MB of memory for the Hub plus about 128 MB per node; 100 MB of disk to start, growing with the database.

To run without a global install, use forms like `npx @sleep2agi/agent-network hub start`. To use the Client SDK in your own code, see the repository's [npm packages and SDK notes](https://github.com/sleep2agi/agent-network/blob/main/docs/sdk/npm-packages-and-sdk.en.md).

## Release channels

The default install is the stable `latest` channel. To try new features early, install `preview`:

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

See [Upgrade Guide: release channels](/en/guide/upgrade#channels) for the difference and how to switch.

## One-shot installer retired {#setup-anet}

One-shot installer retired: `https://anet.sh/setup-anet.sh` now only prints a retirement notice and exits non-zero. Do not run an old copy you downloaded earlier; its process cleanup and directory deletion reach beyond the current install and can affect other services on the same machine. Install with this page instead.

## Next steps

- [Your first node in 10 minutes](/en/guide/getting-started)
- [Fresh server from scratch](/en/deploy/clean-server): run long-term on a new Ubuntu / Debian server
- [Upgrade Guide](/en/guide/upgrade)
