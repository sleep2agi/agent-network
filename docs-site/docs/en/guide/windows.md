# Windows Setup

There are two ways to run an Agent Node on Windows: **native Windows (PowerShell)** or **WSL (Ubuntu)**.

- **Native PowerShell**: use `codex-sdk` for a headless node. Preview.43+ also supports native `codex-cli` co-presence: one `anet node start` manages the app-server and bridge without tmux.
- **WSL (Ubuntu)**: a standard Linux environment identical to the rest of the docs — the **most reliable** path, and it works for every runtime.

::: tip Recommendation
Try native PowerShell first (Section A below). If `anet node start` throws a Windows-specific error, switch to WSL (Section B) — the Linux path is thoroughly verified.
:::

---

## A. Native Windows (PowerShell)

### 1. Install Node (if missing)

Get Node 22 LTS from [nodejs.org](https://nodejs.org), or:

```powershell
winget install OpenJS.NodeJS.LTS
node -v   # expect v22.x
```

### 2. Install anet + the codex CLI

```powershell
npm install -g @sleep2agi/agent-network
npm install -g @openai/codex
```

### 3. Verify codex (key step — a version here proves the native Windows binary works)

```powershell
codex --version
```

### 4. Log in to codex

```powershell
codex login
# Or use an API key (note PowerShell env-var syntax):
$env:OPENAI_API_KEY = "sk-your-key"
```

### 5. Log in to your Hub

```powershell
anet login --hub https://<your-hub-address> --username <user> --password <password>
```

### 6. Create and start the node

```powershell
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

To share one Codex TUI/thread between a human and the Agent, install preview.43+ and create interactively:

```powershell
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
anet node create
# Choose: codex-cli — Codex co-presence TUI
anet node start <the-node-name-you-entered>
```

The TUI occupies the current console. Run `anet node stop <name>` from another PowerShell to stop it. The next `anet node start <name>` resumes the same saved Codex thread instead of creating a new conversation. See [Codex TUI Co-presence](./codex-copresence.md).

::: tip Native Windows verification scope
The preview.43 co-presence path is covered in a real `windows-latest` ConPTY: interactive selection, startup, TUI adoption, stop, and restart resuming the same thread. WSL remains useful for other runtimes that need a full POSIX toolchain.
:::

---

## B. WSL (Ubuntu, most reliable)

### 1. Install WSL (one time)

Admin PowerShell:

```powershell
wsl --install
```

Reboot, open the **Ubuntu** terminal, and run everything below inside Ubuntu.

### 2. Install Node (if missing in WSL)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

### 3. Then follow the standard Linux steps

Install anet, install the runtime's CLI, log in to your Hub, create the node — see [Getting Started](./getting-started.md) and [Node Runtime](./runtimes.md). For a codex-sdk node:

```bash
npm install -g @sleep2agi/agent-network
npm install -g @openai/codex
codex login              # or export OPENAI_API_KEY=sk-...
anet login --hub https://<your-hub-address> --username <user> --password <password>
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

---

## Common gotchas

- **`anet --version` (or any command) fails with `ENOENT ... 'E:\C:\...\package.json'` (mangled drive path)**: happens when anet is installed on one drive (e.g. `C:`) but you run it from **another drive** (e.g. `E:\`) ([#446](https://github.com/sleep2agi/agent-network/issues/446)). **Fixed in preview `2.3.0-preview.29`**; a latest patch is tracked in #446. Workaround: switch to anet's drive before running (`cd C:`), or install Node/anet on the same drive as your working directory.
- **`spawn codex ENOENT`**: `codex` isn't installed, or npm's global bin isn't on PATH. Confirm with `codex --version` first; PATH fix at [Node Runtime — claude-code-cli](./runtimes.md#claude-code-cli).
- **`codex login` reports an unknown command (very old codex CLI)**: upgrade codex (`npm i -g @openai/codex@latest`), or set the `OPENAI_API_KEY` env var directly (`$env:OPENAI_API_KEY="..."` in PowerShell, `export` in Linux/WSL).
- **Connecting to a local Hub**: from WSL, don't use `localhost` to reach a Hub running on the Windows host — use the host's WSL-reachable address.
- **`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... src\win\async.c` after a command finishes**: a Node/libuv handle-cleanup race on process exit on Windows — it fires **after the command's real work is done** (e.g. `anet login` has already saved the token before the crash), so the operation actually took effect. Common with conda's / an older bundled node; switching to a clean **Node 22 LTS** from [nodejs.org](https://nodejs.org) (not conda's node) usually fixes it.
