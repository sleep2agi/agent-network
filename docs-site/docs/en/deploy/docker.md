# Docker Deployment

::: warning No maintained production compose bundle
Dockerfiles and compose files in this repository are test fixtures or integration-specific examples, not a general production template. This page documents only the verifiable minimum path.
:::

## Recommended path: npm + tmux (most reliable)

Most self-hosters actually run **npm global install + tmux + `anet project up`**. It's lighter than docker compose, easier to debug, and iterates faster. See:

- [Fresh-server deployment](/en/deploy/clean-server) — install on a new Ubuntu/Debian host and verify each stage
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
3. `anet login --hub http://127.0.0.1:9200 --username admin` (use the password shown during first startup; run `anet passwd` before exposing the Hub)
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
- [Fresh-server deployment](/en/deploy/clean-server) — complete step-by-step flow for a new server
