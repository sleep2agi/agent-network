# Keeping the Hub alive

A production Hub needs a process supervisor. A bare `nohup ... &` will not recover
after a crash, reboot, or accidental kill.

::: warning Use exactly one supervisor
Do not let PM2, systemd, and a cron watchdog manage the same Hub. Competing
supervisors can start two processes against one port and one SQLite database.
:::

## Prerequisites (in order — each one will stop you)

Measured on a clean machine. All three fail closed with an actionable
message, but the docs never showed them as one chain, so you hit them one at
a time:

| # | What you see if it is missing | Fix |
|---|---|---|
| 1. **Bun ≥ 1.2** | `❌ anet hub start requires the Bun runtime (commhub-server is bun-only — uses Bun.serve + bun:sqlite, no Node fallback)` | `npm i -g bun`, then **restart your shell** so PATH picks it up |
| 2. **Hub running** | `未找到 CommHub Server。请先运行: anet hub start` | `anet hub start` (up in ~3s) |
| 3. **Logged in with a network_id** | `未登录或缺少 network_id。请运行: anet login` | `anet register`, or `anet login` |

::: warning `anet daemon` is not what this page daemonizes
This page is about **keeping the Hub alive with PM2** (`anet hub start`).

`anet daemon init` / `up` is a different thing: it creates and starts a
`host_supervisor` node (RFC-026). Similar names, different jobs.

🔴 **`anet daemon` only exists on the `preview` channel.** The `install.sh` this site
recommends installs `latest`, where the command prints:

```
$ anet daemon
Unknown command "daemon". Did you mean: anet demo?
(exit code 1)
```

Measured 2026-08-18 by running the binary from the real npm tarball of
`@sleep2agi/agent-network@2.2.21` (`latest` at the time) — not by reading `dist`, which
is string-array-obfuscated and cannot be grepped for this. On `preview`
(`2.3.0-preview.39` at the time) the same command prints `Usage: anet daemon <subcommand> …`.

**So the next sentence only holds on preview:** `anet daemon --help` currently prints the
global help — run `anet daemon` with no arguments to see its subcommands. On `latest` you
get the `Unknown command` above — **that is not a broken install.**

If you need `anet daemon`, switch channels first:
`npm i -g @sleep2agi/agent-network@preview`.
:::

## Recommended entry point

Supervise `anet hub start`; do not pin an old `commhub-server` preview in the
configuration. `anet` selects the Server version paired with the installed CLI.

Resolve the real executable paths first:

```bash
command -v anet
command -v bun
```

::: warning Do not use `bunx` / `npx` as the daemon entrypoint
`bunx` / `npx` unpack the package into a cache directory under `/tmp` and **execute it from there**.
After a reboot `/tmp` is cleared and the daemon can no longer start — PM2 will only show repeated
restarts, with no hint of the cause. Always use the **absolute path** from `command -v`.
:::

This PM2 example uses the absolute path returned by `command -v anet`:

```js
// hub.ecosystem.config.js
module.exports = {
  apps: [{
    name: 'commhub-hub',
    script: '/absolute/path/to/anet',
    args: 'hub start',
    interpreter: 'none',
    env: { HOST: '127.0.0.1', PORT: '9200' },
    autorestart: true,
    // min_uptime must exceed how long a failing start takes to exit. If it is
    // smaller, PM2 counts the start as successful, never trips backoff, and a
    // crash loop looks like ordinary restarts.
    min_uptime: 45000,
    // backoff without max_restarts = a failing process retries forever. That is
    // deliberate here: the Hub should keep self-healing. The cost is that a truly
    // broken process retries indefinitely and floods the logs. Add max_restarts
    // if you want it to give up after N attempts.
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

The filename has to let PM2 recognise the file as a **config** rather than a
**script**: `*.config.js`, `*.config.cjs`, `*.json`, and `*.yaml` all work (the
files under `deploy/` in this repo are named `ecosystem.config.cjs`). A name that
matches none of those shapes is executed as a plain script — PM2 may show it as
`online` and never start the Hub.

Start and verify it:

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Do not treat PM2's green status as proof; `/health` proves that the service responds.

## This repo's authoritative config lives in `deploy/`

The example above is a generic starting point. The configuration this project
actually runs in production is already committed — there is no need to retype it:

- [`deploy/hub/ecosystem.config.cjs`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/ecosystem.config.cjs) — the Hub's PM2 process definition (no secrets)
- [`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh) — the guarded launcher, with four fail-closed prechecks (bun / pinned install / vault key / port already listening)
- [`deploy/fleet/`](https://github.com/sleep2agi/agent-network/blob/main/deploy/fleet) — the systemd **user** units and the fleet boot chain
- [`deploy/hub/README.md`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/README.md) — the Hub version-switch procedure (rehearsed)

What sits in `~/.local/bin/` on the production host is a **deployed copy**; the Git
authority is `deploy/`. Change both together, and check for drift with
[`deploy/check-deployed-copies.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/check-deployed-copies.sh).

## Derive `min_uptime` from how long a failing start takes to exit

The rule: `min_uptime` must be **greater** than the time a failing start needs to
reach its exit. Set it lower and PM2 records the failure as a successful start —
`max_restarts` never accumulates, `exp_backoff_restart_delay` never engages, and a
crash loop looks like ordinary restarts.

**How to obtain that number**: read the fixed delays on the guarded script's failure
path. `hub-daemon.sh` routes every failed precheck through `fail_slow()`, which
sleeps 30 seconds and then exits 1 — so a failing start takes about 30 seconds, and
anything guarding it needs `min_uptime` above `30000`. A bare `anet hub start`
usually fails much faster, so the `45000` used in the example above clears both
entry points.

Measured (PM2 inside a `node:22-bookworm-slim` container, the same "exit 1 after 30
seconds" script, observed for 100 seconds — roughly three cycles):

| `min_uptime` | `restarts` | `unstable restarts` |
|---|---|---|
| `20000` | 3 | **0** — backoff never engages |
| `45000` | 3 | 3 |

An `unstable restarts` stuck at 0 is the reading that says this protection is
already inert: PM2 believes every start succeeded. Check that field when reviewing a
supervisor config — `restarts` alone will not tell you. (The review of this repo's
current value is tracked in [#1223](https://github.com/sleep2agi/agent-network/issues/1223).)

## Security boundaries

- Keep `HOST=127.0.0.1` by default. Complete the [production security setup](/en/deploy/production) before allowing remote access.
- Never use `--dev-open` in production.
- Do not put tokens or vault keys in the ecosystem file; PM2 persists environment variables.
- Never clean up with `pkill -f` or `killall`. Resolve and stop the exact PID.
- Keep restart backoff enabled so missing dependencies or registry failures do not create a tight restart loop.

If a secret environment variable is unavoidable, keep it in a separate mode-`600`
file and load it from a minimal wrapper. Verify that the value is absent from logs,
the PM2 dump, and configuration. Avoid `export $(grep ...)`: an empty match can
degrade into a command that prints the whole environment.

## Verify automatic recovery

Test once during a maintenance window:

1. Record the exact PID from `pm2 pid commhub-hub`.
2. Send `SIGTERM` to that PID; do not use a process-name pattern.
3. Confirm that `/health` returns 200 again.
4. Confirm that the PID changed.

All four checks matter. An unchanged PID only shows that the process never stopped;
a new PID with a failing health check only shows that PM2 restarted a broken process.

## Start on boot

```bash
pm2 startup
```

This prints, but does not execute, the systemd command that must run as root. Run
the printed command, verify the Hub, and only then save the process list:

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

`loginctl enable-linger` alone does not create PM2's systemd unit.

## Change configuration safely

Validate the replacement before removing anything. Do not `pm2 delete` the old
entry and then gamble on untested flags.

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Disable an existing cron watchdog before handing ownership to PM2. If ownership is
unclear, stop and identify which supervisor controls the Hub first.

## Related

- [Production and public-internet security](/en/deploy/production)
- [Upgrade guide](/en/guide/upgrade)
- [Troubleshooting](/en/troubleshooting)
- [`deploy/` — the Git authority for this repo's deployment assets](https://github.com/sleep2agi/agent-network/blob/main/deploy)
