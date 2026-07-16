# Feishu Agent — Docker 一键启动

Run a feishu-enabled agent in Docker against your own commhub-server hub. One file (`.env`) + one command (`docker compose up -d`).

## 3-step quickstart

```bash
cd docker/feishu/
cp .env.example .env && $EDITOR .env       # fill the values (see below)
docker compose up -d                       # builds image first time (~2 min)
docker compose logs -f feishu-agent        # tail bring-up + agent logs
```

For a brand-new Feishu app, start and keep this client running **before** saving "使用长连接" in Event Subscription; then save the mode and add only `im.message.receive_v1`. See the [full guide](../../docs-site/docs/en/guide/feishu.md) for the required scopes and connection checks. `bridge online` alone is not proof that Feishu authentication succeeded.

The container's entrypoint runs the full bring-up chain automatically: hub init → login → node create → channel add feishu → start. Node state persists under `./data/.anet/`; each restart reapplies the bootstrap allowlist from `.env`.

## `.env` essentials

```bash
HUB_URL=https://your-hub.example.com       # your own commhub-server URL
HUB_USER=your-username                     # account on that hub
HUB_PASSWORD=your-password                 # login is non-interactive via --username/--password

FEISHU_APP_ID=cli_xxxx                     # from https://open.feishu.cn → your app
FEISHU_APP_SECRET=xxxx
FEISHU_ALLOW_FROM=ou_xxx                   # one app-scoped open_id; required unless FEISHU_ALLOW_CHATS is set

ANET_MODEL=deepseek-v4-pro                 # or MiniMax-M3 (vision) / claude-sonnet-4-6 / etc.
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-xxxx
```

Access allowlist (required — set at least one; empty is not allow-all):
```bash
FEISHU_ALLOW_FROM=ou_xxx                   # one sender open_id (DM)
FEISHU_ALLOW_CHATS=oc_xxx                  # one chat_id (group)
```

The Docker bootstrap does not split comma-separated values, so it currently supports at most one ID of each kind. Do not append extra IDs with the CLI inside the container: the next restart rewrites `access.json` from `.env`. Use the non-Docker manual setup for multi-ID allowlists until the entrypoint is fixed.

See `.env.example` for the full annotated list (verified vendor + model combos, NODE_ALIAS override, etc.).

## Troubleshooting (5 lines)

| log line | what's wrong |
|----------|--------------|
| `HUB_URL: missing — set HUB_URL=...` | a required `.env` var is empty/missing; fix `.env`, re-up |
| `❌ Cannot reach hub: Cannot connect to CommHub server` | `HUB_URL` is wrong or hub is down — verify `curl $HUB_URL/health` from your host |
| `❌ Login failed: invalid username or password` | `HUB_USER` / `HUB_PASSWORD` don't match the hub's account — try `anet login` from a host shell first |
| `[claude] image attachments (N) received but ... text-only` | the picked `ANET_MODEL` isn't on the vision-capable list — switch to MiniMax-M3 or a Claude-native model to send images |
| container restart-loops without entering `[start] exec agent-node` | one of the bring-up steps fails fast (env / login / etc.) — `docker compose logs feishu-agent` shows which step |

## Where state lives

Two subdirectories of cwd are mounted (still a hard blast-radius limit — the agent cannot reach anywhere else on the host):

- **`./data/` → `/work`** — node config, logs, goals, and per-channel `.env` / `access.json` under `./data/.anet/`.
- **`./claude/` → `/root/.claude`** — the claude-agent-sdk **conversation history** (`projects/-work/<session>.jsonl`). The resume id is in `config.json` under `./data/`, but the actual transcript lives here. Without this mount, recreating the container loses the transcript and the bot can't resume prior context ("No conversation found").

Everything else on your host is unreachable from inside the agent. Both dirs are auto-created on first `up`.

## Versions

Image pins exact preview versions of `@sleep2agi/agent-network` + `@sleep2agi/agent-node` via Docker `ARG`. To rebuild against a newer preview:
```bash
ANET_VERSION=2.2.23-preview.0 ANET_NODE_VERSION=2.4.16-preview.0 docker compose build
docker compose up -d
```

Promoted-to-latest support comes once the preview UAT cycle settles; until then this template tracks the verified preview chain. See the Dockerfile header for the currently-pinned versions.

## Self-test (optional)

Spin up a throwaway local hub alongside the agent for an isolated smoke test (does NOT touch your real hub):

```bash
HUB_URL=http://hub:9200 HUB_USER=admin HUB_PASSWORD=anethub docker compose --profile local-hub up -d
```

(`local-hub` is a compose profile — opt-in only. Default `docker compose up` does NOT start the test hub.)
