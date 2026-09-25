# Keeping the Hub running (pm2 / systemd)

A production Hub needs a process supervisor. A bare `nohup anet hub start &` does not recover after a
crash, reboot, or accidental kill. This page supervises `anet hub start` with PM2 and also shows the
equivalent systemd setup.

::: tip Looking for `anet daemon`?
`anet daemon` is something else: a `host_supervisor` node that the Dashboard can drive remotely to create
nodes on a machine for you. See [`anet daemon`: create nodes on a remote machine](/en/deploy/daemon).
:::

::: warning Use exactly one supervisor
Do not let PM2, systemd, and a cron watchdog manage the same Hub. Competing supervisors can start two
processes against one port and one SQLite database.
:::

## Prerequisites {#prereqs}

- Bun ≥ 1.2, with both `bun` and `bunx` on the supervisor's PATH. `anet hub start` launches the paired
  commhub-server through `bunx` and exits with an error if `bunx` is missing.
- Run `anet hub start` once in the foreground and confirm `curl -fsS http://127.0.0.1:9200/health`
  succeeds before handing it to a supervisor.

## Recommended entry point: PM2 supervising `anet hub start` {#pm2}

Supervise `anet hub start`; do not pin a `commhub-server` version in the configuration. `anet` selects
the Server version paired with the installed CLI.

Resolve the real paths first:

```bash
command -v anet
command -v bun
```

::: warning Use an absolute path, not `bunx` / `npx`, as the entry point
A supervisor does not read your interactive shell's PATH, so the entry point must be the absolute path
from `command -v anet`. Using something like `npx @sleep2agi/agent-network hub start` as the entry point
can resolve a different version on every restart and depends on reaching the npm registry at that moment.
:::

Replace `script` with the absolute path returned by `command -v anet`:

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
    // Must exceed how long a failing start takes to exit; see the min_uptime section below.
    min_uptime: 45000,
    // Backoff without max_restarts: a failing process retries forever. Add max_restarts for a cap.
    exp_backoff_restart_delay: 200,
    kill_timeout: 10000,
    max_memory_restart: '2G',
  }],
};
```

The filename has to let PM2 recognise the file as a config rather than a script: `*.config.js`,
`*.config.cjs`, `*.json`, and `*.yaml` all work. A name that matches none of those is executed as a plain
script; PM2 may show it as `online` while the Hub never listens.

Start and verify it:

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

PM2's green status is not proof; a successful `/health` is.

The Hub's database lives under the running user's `~/.commhub/` by default, so whichever user starts PM2
owns the database it uses.

## Choosing `min_uptime` {#min-uptime}

`min_uptime` must be greater than the time a failing start needs to reach its exit. Set it lower and PM2
records the failure as a successful start: `max_restarts` never accumulates,
`exp_backoff_restart_delay` never engages, and a crash loop looks like ordinary restarts.

That time depends on how long the supervised command waits on its failure path. A bare `anet hub start`
usually fails quickly. This repository's
[`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh)
sleeps 30 seconds before `exit 1` on a failed precheck, so supervising it needs `min_uptime` above
`30000`. The `45000` in the example covers both entry points.

When reviewing a supervisor config, check `unstable restarts` in `pm2 describe commhub-hub`: if the
process keeps failing and this stays at 0, `min_uptime` is too small and backoff has never engaged.
`restarts` alone cannot tell you.

## Verify automatic recovery {#verify-recovery}

Test once during a maintenance window rather than discovering a broken supervisor during a real outage:

1. Record the exact PID from `pm2 pid commhub-hub`.
2. Send `SIGTERM` to that PID; do not kill by process-name pattern.
3. Confirm that `/health` returns 200 again.
4. Confirm that the PID changed.

All four checks matter. An unchanged PID only shows the process never stopped; a new PID with a failing
health check only shows PM2 restarted a broken process.

## Start on boot {#boot}

```bash
pm2 startup
```

This prints, but does not execute, the systemd command that must run as root. Run the printed command,
verify the Hub, and only then save the process list:

```bash
pm2 save
ls /etc/systemd/system/pm2-*.service
```

`loginctl enable-linger` alone does not create PM2's systemd unit.

## Using systemd instead of PM2 {#systemd}

If you would rather not install PM2, systemd can supervise `anet hub start`; see the unit example in [Fresh server from scratch · persistence](/en/deploy/clean-server#_8-persistence-systemd-tmux). A service does not read your shell profile, so set a `PATH` that includes the directory of `bun` / `bunx` explicitly in the unit. Give one Hub to one supervisor only; do not let PM2 and systemd manage it at the same time.

## Security boundaries {#security}

- Keep `HOST=127.0.0.1` by default. Complete the [production security setup](/en/deploy/production)
  before allowing remote access.
- Never use `--dev-open` in production.
- Do not put tokens or vault keys in the ecosystem file or unit file; PM2 persists environment variables.
- Never clean up with `pkill -f` or `killall`. Resolve and stop the exact PID.
- Keep restart backoff enabled so missing dependencies or registry failures do not create a tight
  restart loop.

If a secret environment variable is unavoidable, keep it in a separate mode-`600` file and load it from a
minimal wrapper. Verify that the value is absent from logs, the PM2 dump, and configuration. Avoid
`export $(grep ...)`: an empty match can degrade into a command that prints the whole environment.

## Change configuration safely {#update-config}

Validate the replacement before removing anything. Do not `pm2 delete` the old entry and then gamble on
untested flags.

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Disable an existing cron watchdog before handing ownership to PM2. If ownership is unclear, stop and
identify which supervisor controls the Hub first.

## A fuller reference configuration {#reference-config}

This repository's [`deploy/hub/`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub) holds
a supervised setup with prechecks that you can use as a reference when hardening yours:

- [`ecosystem.config.cjs`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/ecosystem.config.cjs): the PM2 process definition (no secrets)
- [`hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh): the
  supervised launcher, which checks bun, the pinned install, the vault key, and whether the port is
  already taken, and refuses to start if any check fails
- [`README.md`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/README.md): the Hub version-switch procedure

It is written for this project's own directory layout; replace the paths before reusing it.

## Related {#related}

- [`anet daemon`: create nodes on a remote machine](/en/deploy/daemon)
- [Production and public-internet security](/en/deploy/production)
- [Upgrade guide](/en/guide/upgrade)
- [Troubleshooting](/en/troubleshooting)
