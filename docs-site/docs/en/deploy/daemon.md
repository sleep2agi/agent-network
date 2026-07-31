# Keeping the Hub alive

A production Hub needs a process supervisor. A bare `nohup ... &` will not recover
after a crash, reboot, or accidental kill.

::: warning Use exactly one supervisor
Do not let PM2, systemd, and a cron watchdog manage the same Hub. Competing
supervisors can start two processes against one port and one SQLite database.
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

The filename must end in `*.config.js`, `*.json`, or `*.yaml`. PM2 may execute a
plain `.cjs` file as a script, show it as `online`, and never start the Hub.

Start and verify it:

```bash
pm2 start hub.ecosystem.config.js --only commhub-hub
pm2 status commhub-hub
curl -fsS http://127.0.0.1:9200/health
```

Do not treat PM2's green status as proof; `/health` proves that the service responds.

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
