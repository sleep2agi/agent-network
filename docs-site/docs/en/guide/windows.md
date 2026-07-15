# Windows Setup

There are two ways to run an Agent Node on Windows: **native Windows (PowerShell)** or **WSL (Ubuntu)**.

- **Native PowerShell**: `anet` is a Node CLI, `@openai/codex` ships a native Windows binary, and a **codex-sdk node needs neither tmux nor bun** (commhub is parent-mediated inside the agent-node process) — a clean dependency chain, well suited to **codex-sdk** nodes.
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
codex auth login
# If that reports an unknown command, try: codex login
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

::: warning `anet node start` is the key step
The earlier steps (install, `codex --version`, login, create) have a clean dependency footprint on native Windows and should be smooth. `anet node start` is where the agent-node runtime actually launches on Windows — native Windows is a **newer, less battle-tested** path, so if you hit a Windows-specific error here (child-process spawn, the optional `node-pty` dependency, etc.), switch to **WSL** below.
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
codex auth login              # or export OPENAI_API_KEY=sk-...
anet login --hub https://<your-hub-address> --username <user> --password <password>
anet node create codex-node --runtime codex-sdk
anet node start codex-node
```

---

## Common gotchas

- **`spawn codex ENOENT`**: `codex` isn't installed, or npm's global bin isn't on PATH. Confirm with `codex --version` first; PATH fix at [Node Runtime — claude-code-cli](./runtimes.md#claude-code-cli).
- **`codex auth login` reports an unknown command**: use `codex login`, or set the `OPENAI_API_KEY` env var directly (`$env:OPENAI_API_KEY="..."` in PowerShell, `export` in Linux/WSL).
- **Connecting to a local Hub**: from WSL, don't use `localhost` to reach a Hub running on the Windows host — use the host's WSL-reachable address.
