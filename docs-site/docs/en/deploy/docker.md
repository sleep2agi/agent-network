# Docker Deployment

::: warning Full Docker deployment guide pending
This page used to be built on top of the `demos/codex-telegram-squad/` Dockerfile + docker-compose, which was removed during the [#198](https://github.com/sleep2agi/agent-network/issues/198) docs rewrite — the old paths are stale. The full Docker deployment guide (hub + dashboard + multi-agent one-shot compose) is queued for the v0.11+ doc rework.

Until then, the section below is the minimum "this actually works" path.
:::

## Recommended path: npm + tmux (most reliable)

Most self-hosters actually run **npm global install + tmux + `anet project up`**. It's lighter than docker compose, easier to debug, and iterates faster. See:

- [One-shot install (multi-agent + tmux)](/en/guide/one-shot-install) — `setup-anet.sh` spins up hub + dashboard + multiple agents on a blank Ubuntu/Debian box in one command
- [npm deployment guide](/en/deploy/npm) — manual, step-by-step
- [Production / public-internet deployment](/en/deploy/production) — TLS / firewall / backup / public-internet risks

All `@sleep2agi/agent-network` CLI commands (`anet hub start` / `anet hub dashboard` / `anet node create/start` / `anet project up/restart/down`) behave identically inside a plain Docker container and on bare host — just treat the container as "Ubuntu with Node.js + Bun".

## Want to write your own Dockerfile?

The repo ships a few **test-grade** Dockerfiles you can steal as a starting point:

- [`tests/Dockerfile`](https://github.com/sleep2agi/agent-network/blob/main/tests/Dockerfile) — Node.js + Bun base image + anet install, minimum
- [`tests/qa-hub-13-server-health-agents/Dockerfile`](https://github.com/sleep2agi/agent-network/blob/main/tests/qa-hub-13-server-health-agents/Dockerfile) — runnable hub + multi-agent reference

These are release-gate test images, **not optimized for production** (no multi-stage / no pinned hashes / no non-root user). Add your own hardening before production.

## Startup order

Whether docker compose or plain tmux, the per-box startup order is the same:

1. `anet hub start --host 0.0.0.0` (bind LAN; default `127.0.0.1` is fine for purely local use)
2. `anet hub dashboard`
3. `anet login --username admin --password <your-password>` (the first `anet hub start` auto-bootstraps `admin` / `anethub` — **run `anet passwd` to change the password before any public-internet deploy**)
4. `anet node create <alias>` × N (one config per agent)
5. `anet project up` to bring every node in cwd up

A containerized version is just steps 1–5 split across different services / containers.

## Common pitfalls

- **`bunx` pulling `commhub-server` is slow on first boot**: the first `anet hub start` fetches a PINNED `commhub-server` from npm — first-time container startup can be 30–60s slower than host (cache lives at `$HOME/.bun/install/cache`). Pinning a base image and pre-warming the cache helps a lot
- **Dashboard container must reach Hub**: the Dashboard uses REST + SSE against hub `:9200` — either share a docker network across containers or publish hub's port to the host
- **Persist per-node cwd**: `anet node start` writes state under cwd `.anet/nodes/<alias>/` — mount cwd as a volume if you want it to survive container restart
- **Don't run the agent as PID 1**: wrap it with `tini` or similar; otherwise SIGTERM hits the agent directly and bypasses the CommHub offline notification

## Next

- [npm deployment guide](/en/deploy/npm) — non-Docker step-by-step
- [Production / public-internet deployment](/en/deploy/production) — TLS / firewall / backup / safety
- [One-shot install](/en/guide/one-shot-install) — fastest path
