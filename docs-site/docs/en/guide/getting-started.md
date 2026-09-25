# Your First Node in 10 Minutes

<!-- 🔴 Two machine-readable stamps, read by scripts/check-doc-version-claims.py; invisible when rendered.
     This page makes several **version-scoped behavioural claims** (what the very first command does on a
     given version). They all become false the moment a new version ships. The release gate compares the
     version being published against these stamps and blocks the release, listing every line to update.
     Change the prose, change the stamp — the gate also fails when the two disagree.
     Only "current state" claims are stamped; historical references (e.g. `<= 2.3.0-preview.37`) are not. -->
<!-- version-claim: package=agent-network channel=latest version=2.3.0-preview.76 -->
<!-- version-claim: package=agent-network channel=preview version=2.3.0-preview.115 -->

From starting a Hub to chatting with your first agent in the Dashboard: **4 steps**, each with one command and one check.

**Before you start**: install Node.js ≥ 22.13, Bun ≥ 1.2 and `anet` as described in [Install](/en/guide/install), and make sure `anet -v` prints normally. Already installed and only upgrading? See the [Upgrade Guide](/en/guide/upgrade).

::: tip Fastest path (recommended): zero config with a Claude subscription
With Claude Code CLI installed (`npm i -g @anthropic-ai/claude-code`) and `claude auth login` done, pick the **`claude-code-cli` runtime** in step 3: no API key, no model picker. Without a Claude subscription, use `claude-agent-sdk` plus one model API key (MiniMax / DeepSeek / InternLM / Xiaomi); see step 3.
:::

---

## 1. Start the Hub {#start-hub}

Open terminal #1, **keep it running**:

```bash
anet hub start
```

The hub listens on `http://127.0.0.1:9200` by default, the SQLite DB lives at `~/.commhub/commhub.db`, and an admin account **`admin`** is created automatically with a **randomly generated password that is printed only this once** (an `anet-xxxxxxxx…` string, on both the `latest` and `preview` channels). **Save it right away** — step 2 needs it.

::: warning Change the password before going public
Your first login prompts you to replace the random password. **Any `--host 0.0.0.0` public deployment must `anet passwd` to a strong password immediately.** To choose the initial password yourself, run `anet hub start --password <pass>` or set `ANET_HUB_BOOTSTRAP_PASSWORD`.
:::

::: tip Stop / status
`anet hub status` / `anet hub stop` (no more `lsof + kill`).
:::

---

## 2. Start the Dashboard and log in {#login}

Open terminal #2, **keep it running**:

```bash
anet hub dashboard
```

Open `http://localhost:3000` in your browser and log in as `admin` with **the password your own `anet hub start` printed**.

::: warning Take the password from your own `anet hub start` output — do not copy it from this page
The first `anet hub start` prints the admin credentials once:

```
✅ Admin account created
   username: admin
   password: <the string printed there>
   Store this password now; it will not be shown again.
```

Today's `latest` (`2.3.0-preview.76`) and `preview` (`2.3.0-preview.115`) both print a random password: `anet-` followed by 22 hex characters.
The fixed `admin / anethub` only exists on `2.2.x` and earlier; it will not log you in to a freshly installed Hub.

The credentials are also written to `~/.anet/server/admin-utok.json`, which holds only
`username` / `user_id` / `token` / `created_at` — **the password is not in there**, so if you
miss that one line of output you have to bootstrap again (or run `anet hub admin reset-user` on the Hub machine).
:::

In terminal #3, log the CLI in too (so subsequent `anet node ...` commands carry the credentials):

```bash
anet login --hub http://127.0.0.1:9200 --username admin --password <password printed by anet hub start>
```

`anet whoami` confirms your identity.

---

## 3. Create and start a node {#create-node}

```bash
anet node create my-bot
```

The wizard asks: runtime → (only for `claude-agent-sdk`) vendor → model → API key.

::: tip Easiest path for newcomers — pick `claude-code-cli` manually
The wizard **defaults to highlighting `claude-agent-sdk`**; pressing Enter all the way lands you on the vendor + API-key path. If you've already done `claude auth login`, **manually picking `claude-code-cli`** is the zero-config fastest path.

`anet node create` lists all 7 runtimes (4 stable: `claude-agent-sdk` / `claude-code-cli` / `codex-sdk` / `grok-build-acp`; 3 preview: `codex-app-server` (shown as `codex-cli` in the menu) / `grok-build-cli` / `opencode-cli`); the full comparison is here: [Runtime comparison](/en/guide/runtimes#runtimes-—-canonical-table).
:::

Start the node:

::: warning Fresh install + claude-agent-sdk / codex-sdk? Install agent-node first
These runtimes depend on the `agent-node` package. The first `node start` triggers an npx auto-fetch that takes ~1 minute, but on **builds `≤ 2.3.0-preview.37`** (including the older `2.2.21`) the startup check **doesn't wait for it** and exits with `agent-node is not installed or cannot report a version` ([#450](https://github.com/sleep2agi/agent-network/issues/450)). The fix is [PR #239](https://github.com/sleep2agi/agent-network/pull/239), **present in builds since `2.3.0-preview.38`**; both channels are past that floor now (check yours with `anet -v`; check where the channels point with `npm view @sleep2agi/agent-network dist-tags`). If you are on an older build: `anet upgrade`, or pre-install `agent-node` so the binary is already there:

```bash
npm install -g @sleep2agi/agent-node
```
:::

```bash
anet node start my-bot
```

When you see `SSE connected`, the node is online. Keep the terminal running.

::: warning Ctrl+C during vendor selection can leave a half-baked node
Clean a half-baked node with `anet node delete <alias>` (run once without `--force` to see the will-delete preview, then add `--force` to actually delete).
:::

---

## 4. Dispatch a task from the Dashboard {#dispatch}

Back in your browser at `http://localhost:3000`:

1. Open **Overview** and click the online `my-bot` card to open its embedded ChatPanel (there is no standalone Chat navigation page)
2. Type a message in the input ("what time is it?" / "write hello world"), hit Enter
3. Your message appears immediately with an optimistic echo (`You` label)
4. After the agent calls the LLM, the reply appears with full markdown rendering (`↳ my-bot` label)

Refresh the page — chat history is preserved.

✅ **Done.**

---

## Next steps

**Advanced**:
- [Multi-agent coordination](/en/guide/architecture#agent-node) — peer agents auto-coordinate via `get_all_status` / `send_task` / `get_task`
- [Batch node management with `anet project up/restart/down`](/en/guide/batch) — start/stop every node under cwd in one command; zero-keyboard recovery after reboot
- [LAN-shared hub](/en/deploy/clean-server#_2-start-the-hub-recommended-under-tmux) — `anet hub start --host 0.0.0.0` lets other machines join

**Demos** (experimental, for a quick taste):
```bash
anet demo                  # list available demos
anet demo pr-review        # PR review room — 3 reviewers (security/perf/style) + judge
```

**Deeper**:
- [CLI command reference](/en/guide/cli)
- [Agent Node config](/en/guide/agent-node) — config.json fields + `/aloop` scheduler
- [Multi-model config](/en/guide/multi-model) — DeepSeek / Kimi / Claude / MiniMax / self-hosted
- [Architecture overview](/en/guide/architecture)
- [Upgrade Guide](/en/guide/upgrade) — any older version → latest with a single `anet upgrade`
- [Production deployment](/en/deploy/production) — there is no hosted Hub; read this before putting a Hub on a server or the internet
