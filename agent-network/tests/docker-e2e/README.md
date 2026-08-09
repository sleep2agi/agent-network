# Agent Network — Docker E2E

One command to run a hermetic 7-scenario end-to-end test of the full
stack (hub + dashboard + agent-node) inside Docker.

```bash
cd tests/docker-e2e
./run-e2e.sh
```

Expected runtime: ~90s on warm caches, ~3min on cold caches.
Expected output: `PASS` or `FAIL` with the failing scenario name.

## What it tests

| #  | Scenario | What it verifies |
|----|----------|-----------------|
| 01 | UI register | Register form on `/login` lands user on the authed dashboard |
| 02 | Create node (API) | `POST /api/auth/node-token` mints a usable `ntok_` |
| 03 | SSE connected | The `vbot` agent-node container shows up online in `/api/status` |
| 04 | Send via Enter | Typing + plain Enter (not Cmd+Enter) sends the message; bubble appears in <1s |
| 05 | Failed reply | Agent's failed reply text ("http 错误...") lands as a result bubble + status pill flips to "failed"; hub `/api/tasks` shows `status=failed` |
| 06 | Refresh keeps history | Hard browser refresh re-loads the user msg + agent reply |
| 07 | Multi-message | 3 rapid sends preserve order in the chat history |

### Documented gap

Scenario 02 calls the REST API directly instead of running `anet node
create` inside the agent-node container. The CLI's `node create`
command runs an interactive two-step picker (network select + alias
prompt) that can't be driven from a non-tty docker exec. The REST
endpoint it dispatches to (`POST /api/auth/node-token`) is what
matters; that's covered.

## Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────────┐
│   hub    │←───│ dashboard│←───│  playwright  │
│  :9200   │    │  :3000   │    │   (runner)   │
│ bun src  │    │  npx pre │    │  npm install │
│ from     │    │  view@7  │    │  + run tests │
│ ../../   │    │          │    └──────┬───────┘
│ server   │    └──────────┘           │
└────┬─────┘                            │
     │      ┌────────────┐              │
     └──────│ agent-node │  reads state │
            │  npx pre13 │  from        │
            │  fake key  │  test-state  │
            │  (replies  │  .json       │
            │  fail)     │              │
            └────────────┘              │
                                         │
            .tmp/test-state.json ←───────┘
            (utok, ntok, network_id, alias)
```

- **hub**: Bun runs the local `server/src/index.ts` source (so we test
  pre-publish code).
- **dashboard**: pulls the published `@preview` tag — that's what real
  users get from `npx`.
- **agent-node**: same — published `@preview` tag, pre-configured with
  a fake MiniMax key so its replies always fail (which is what
  scenario 05 wants to assert).
- **playwright**: a one-shot container based on the official
  Playwright Jammy image. Runs `npm install` + `npx playwright test`.
  No browsers needed on the host.

## State

All state lives under `tests/docker-e2e/.tmp/` (gitignored) and in
docker-compose volumes (`anet_e2e_*`). `cleanup()` in `run-e2e.sh`
runs `docker compose down -v` on exit which wipes the volumes too.

Pass `--keep` to leave containers up for triage:

```bash
./run-e2e.sh --keep   # leaves the stack running on :9200 / :3000
```

After `--keep`, tear down manually:

```bash
docker compose --project-name anet_e2e down -v
```

## Ports

The stack maps to the host on **non-default ports** so it doesn't fight
with a developer commhub-server on `:9200` or a Next.js dev server on
`:3000`:

| Service   | Inside docker | Host  |
|-----------|---------------|-------|
| hub       | `hub:9200`    | 9201  |
| dashboard | `dashboard:3000` | 3001 |

Open `http://localhost:3001/login` after `--keep` to poke at the live
dashboard manually.

## Files

- `docker-compose.yml` — 4 services
- `run-e2e.sh` — orchestration entrypoint
- `playwright/playwright.config.ts` — runner config (sequential, JUnit + HTML reporters)
- `playwright/helpers.ts` — auth shortcut + state loader + waitFor()
- `playwright/0[1-7]-*.pw.ts` — the 7 Playwright-only scenarios (the custom
  suffix keeps Bun's default test discovery from loading Playwright fixtures)

## Troubleshooting

- **Hub never comes up**: usually `bun install` first run. Re-run; the
  named `hub_node_modules` volume caches the install.
- **Dashboard never comes up**: `npx -y @sleep2agi/agent-network-dashboard@preview`
  is downloading 19MB. Cold runs take ~30s here.
- **Scenario 03 fails** but everything else works: agent-node SSE flake
  (it auto-reconnects). Check `docker compose logs agent-node`.
- **Scenario 05 stuck waiting for ❌**: agent-node may not have received
  the task. Check `docker compose logs agent-node` — should see "← SSE
  new_task" lines after each test sends a message.
