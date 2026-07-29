# Keeping the hub alive: process supervision

The hub is the network's single point of failure. If it dies, every node drops at once.

But "getting it running" and "keeping it running" are two different jobs. This page covers the second one, along with several traps that **look green while nothing is actually working**. Every one of them was hit in production.

::: tip Scope
Long-running self-hosted hubs (`anet hub start` / `commhub-server`).
You don't need any of this for a local dev run.
:::

## Why bare `nohup` isn't enough

The usual way to start it:

```bash
nohup commhub-server > hub.log 2>&1 &
```

That works, but it has two problems:

1. **Nothing brings it back once the process is gone.** Crash, OOM, stray kill — all the same, and you only find out by looking.
2. **Stray kills are easier than you'd think.** If test instances have ever run on the same machine, a single `pkill -f commhub-server` takes out production **and** the test instances — they share a process-name pattern.

Point 2 deserves emphasis because the diagnostic signature is unusually clean: **every same-named process gone while all other services are untouched** points squarely at a pattern kill, not OOM (which picks one victim) and not a crash (which kills one process).

**So: clean up processes by exact PID. Never `pkill -f` or `killall`.**

## Trap 1: your hub may be running out of `/tmp`

If the start command is `bunx`/`npx` with a pinned version:

```bash
bunx --bun @sleep2agi/commhub-server@0.9.0-preview.14   # ⚠️
```

then **the binary actually executing lives in a `/tmp` cache directory**:

```
/tmp/bunx-<uid>-@sleep2agi/commhub-server@0.9.0-preview.14/node_modules/.bin/commhub-server
```

Check whether this is you:

```bash
tr '\0' ' ' < /proc/<hub-pid>/cmdline    # a /tmp path means you're affected
```

**This is a failure that only surfaces on the next restart.** The current process is fine, `/health` keeps returning 200, and no amount of checking current state reveals it. Then `/tmp` gets cleared — a reboot, tmpwatch, a manual disk cleanup — and the next start fails outright, usually at the exact moment you most need it to come up.

**Switch to a durable install**, taking `/tmp` and the network off the startup path:

```bash
mkdir -p ~/.commhub/runtime && cd ~/.commhub/runtime
cat > package.json <<'EOF'
{
  "name": "commhub-runtime",
  "private": true,
  "dependencies": { "@sleep2agi/commhub-server": "0.9.0-preview.14" }
}
EOF
npm install
```

Then exec the installed entry point directly. Bonus: **startup no longer needs network access**, so the hub can restart even if the registry is down.

Changing versions = edit the version in `package.json`, `npm install`, restart — then **`curl /health` and confirm the version actually changed**.

## The start script: four fail-closed preflight checks

Block these cases before starting, and write the reason to the log in each case:

| Condition | Behavior | Why |
|---|---|---|
| Runtime (bun/node) not found | Refuse to start | — |
| Durable install missing | Refuse to start | Point the operator at `npm install` |
| Secret missing or empty | **Refuse to start** | Starting with an empty key makes ciphertext fail to decrypt silently — harder to diagnose than not starting |
| Port already listening | **Refuse to start** | Never let a second hub grab the same database |

That last one matters most: two hub processes pointed at one SQLite file *will* start successfully, and the damage shows up later in ways that are very hard to reproduce.

On preflight failure, prefer `sleep 30` before exiting (**fail slowly**) so the process manager's backoff can engage. One service that failed instantly and restarted instantly racked up 34,000+ restarts overnight, hammering the registry the whole time.

::: warning Port and database path must be overridable by environment variables
Otherwise any attempt to verify that the script works will go after the production port — which verifies nothing and leaves a perpetually restarting entry behind.

What you verify has to be **the script itself**, not a lookalike copy of it.
:::

## Trap 2: pm2 does not recognize `.cjs` config files

The config filename matters. Hand pm2 a `hub.ecosystem.cjs`:

```bash
pm2 start hub.ecosystem.cjs      # ⚠️ not parsed as config
```

pm2 **won't treat it as configuration**. It runs it **as an ordinary script**, and then:

- the process is named after the file (`hub.ecosystem`), **not** the `name` in your config
- status reads `online`
- **nothing is listening; the service never started**

A no-op wearing a green checkmark. The tell is that the `name` in `pm2 jlist` doesn't match the one in your config.

**Config files must be named `*.config.js`, `*.json`, or `*.yaml`.**

## Trap 3: `min_uptime` has to match your failure path

`min_uptime` **exists only in ecosystem config files — the pm2 CLI does not accept it as a flag**. So services started via CLI never have it set, and fall back to the 1-second default.

Combine that with the "fail slowly" advice above (`sleep 30; exit 1`) and it breaks: 30 seconds > the 1-second default, so pm2 concludes the process **did start stably** before exiting — and **resets the exponential backoff delay**. Every failure starts backing off from scratch, so the service **restarts forever at a constant, fast rate**.

Measured (5-second failure path, `max_restarts: 3`, the two apps differing only in `min_uptime`):

| | `min_uptime: 1000` (below failure path) | `min_uptime: 15000` (above it) |
|---|---|---|
| Restarts in 3.5 minutes | **15, still climbing** | **2, then flat** |
| Backoff actually engaging | No — reset each time | Yes — interval grows fast |

**Rule: `min_uptime` must exceed how long your failure path takes.** If it sleeps 30, set 45000.

::: warning With exp_backoff_restart_delay set, don't expect an errored state
Neither app above **ever entered `errored`** — even with `max_restarts` set to 3.
Once `exp_backoff_restart_delay` is configured, pm2 **replaces** the "stop at max_restarts" behavior with exponential backoff: it keeps retrying indefinitely, just further and further apart.

So the value of `min_uptime` isn't "fail enough times and it stops and reports" — it's **making the backoff actually work**.

If you need to know when a service is down, that has to come from **external monitoring** (a periodic `/health` probe, say). Don't count on pm2 entering `errored` to tell you.
:::

A working configuration:

```js
// hub.ecosystem.config.js — mind the extension
const SHARED = {
  script: '/path/to/hub-daemon.sh',
  interpreter: 'bash',
  autorestart: true,
  min_uptime: 45000,               // longer than the failure path's sleep
  max_restarts: 20,
  exp_backoff_restart_delay: 200,  // back off instead of spinning
  kill_timeout: 10000,             // time to drain SSE connections and WAL
  max_memory_restart: '2G',
};

module.exports = {
  apps: [
    { ...SHARED, name: 'commhub-hub',
      env: { HOST: '0.0.0.0', PORT: '9200' } },
    // Exists only to prove pm2 accepts every option above. Delete after verifying.
    { ...SHARED, name: 'commhub-hub-selftest',
      env: { HOST: '127.0.0.1', PORT: '19200',
             COMMHUB_DB: '/tmp/selftest/hub.db' } },  // never the production DB
  ],
};
```

The `selftest` entry shares the **same `SHARED` options object** as the production entry. Getting it running therefore verifies the production entry's option set, rather than verifying something that merely resembles it.

## Don't hand secrets to the process manager

If your hub needs a vault key (`ANET_HUB_SECRET_VAULT_KEY`), **keep it out of the ecosystem config**. pm2 persists env into `~/.pm2/dump.pm2`, whose permissions are looser than you want for a key.

Put it in its own `600` file and have the start script read it at runtime:

```bash
umask 077
echo "ANET_HUB_SECRET_VAULT_KEY=<your key>" > ~/.commhub/hub.env
chmod 600 ~/.commhub/hub.env
```

Load it like this:

```bash
set -a
source ~/.commhub/hub.env
set +a
```

::: danger Never use export $(grep ...)
`export $(grep KEY file | xargs)` degrades into a bare `export` when the grep matches nothing, dumping **the entire environment** — including your other tokens.
:::

Afterwards, confirm the key didn't leak anywhere (count only — never print the value):

```bash
grep -c 'ANET_HUB_SECRET_VAULT_KEY' ~/.pm2/dump.pm2 hub.ecosystem.config.js *.log
# expect all zeros
```

## Verification: you have to actually kill it

Writing the config doesn't mean supervision works. **Kill the selftest instance for real:**

```bash
kill -9 <selftest-pid>
# then poll
curl -sf 127.0.0.1:19200/health
```

Both conditions must hold:

- `/health` returns 200 again
- **the PID changed** (otherwise it merely didn't die, which isn't recovery)

It should be back within seconds. Remember to `pm2 delete` the selftest afterwards.

::: warning With multiple gates, each red test must report its own reason
Asserting only "nothing is listening afterwards" is too weak — *any* early failure satisfies it.

Observed in practice: all four test cases **stopped at the first gate** (a wrong runtime path), the other three never executed, and every assertion passed.

Give each gate a distinguishable reason string and grep for that specific one in each red test. Four distinct reasons means four gates verified.
:::

## Coexisting with a cron watchdog

If you already have a cron watchdog restarting the hub, **it must stand down once pm2 owns the process**:

```bash
if pm2 jlist 2>/dev/null | grep -q '"name":"commhub-hub"'; then
  echo "managed by pm2; watchdog standing down"
  exit 0
fi
```

Otherwise it starts a bare process pm2 doesn't know about, and you end up with two instances — pm2's and the watchdog's — competing for one database.

The watchdog itself needs two constraints: **act only after several consecutive failed probes** (so transient blips don't trigger restarts), and **confirm nothing is listening on the port before acting** (a live port means slow, not dead — starting another one is wrong).

## Starting on boot

**Configuring pm2 does not by itself survive a reboot.** You have to let pm2 generate a systemd unit first:

```bash
pm2 startup            # only PRINTS the root command to run; it doesn't run it
```

Then run the command it printed, verbatim, as root (paths vary by environment):

```bash
sudo env PATH=$PATH:/path/to/node/bin /path/to/pm2 startup systemd -u <user> --hp /home/<user>
```

Finally, save the current process list:

```bash
pm2 save               # only after confirming the service is genuinely up
```

::: warning loginctl enable-linger alone is not enough
`loginctl enable-linger <user>` keeps a user's systemd session alive without a login, but **it does not create pm2's unit** — on its own, nothing starts pm2 at boot.

The two solve different problems: `pm2 startup` decides *who starts pm2 at boot*; linger decides *whether the user session persists without a login*.

One-line self-check:

```bash
ls /etc/systemd/system/pm2-*.service     # missing = boot autostart is not configured
```
:::

It works fine without this; you just have to `pm2 resurrect` manually after a restart.

::: warning Run pm2 save last
Confirm the service is genuinely up before `pm2 save`, or you'll persist a broken state into boot.
:::

## Order of operations when changing config

The last rule, and the one that cost the most to learn:

**Always prove the new thing starts before touching the old one.**

Don't `pm2 delete <old>` and then `pm2 start <new flags>`. `delete` is the irreversible step; `start` is the step that can fail (for instance, on a flag the CLI doesn't accept). Putting the irreversible step first bets production on your guess that every flag is right.

With an ecosystem file you can replace atomically, no delete required:

```bash
pm2 startOrReload hub.ecosystem.config.js --only commhub-hub
```

## Related

- [Production / Public Internet](/en/deploy/production)
- [Fresh Server From Scratch](/en/deploy/clean-server)
