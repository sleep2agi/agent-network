// #516 — `--help` / `-h` for every anet command and subcommand.
//
// The universal intercept in bin/cli.ts (#215) already stops `--help` from
// reaching business logic. What it printed was the problem (#502 audit):
//   - `anet login|logout|whoami|config|upgrade|… --help` → the 139-line global help
//   - `anet node create|stop|delete|ls|edit|rename|… --help` → one generic line
//   - `anet network create --help` → the group handler ran with sub="create" and
//     tried to create a network named "--help".
//
// This table holds the per-command usage. Groups that already had a usage
// printer in bin/cli.ts (hub / project / daemon / network / channel / session /
// goal / token / batch / opencode, `node start`, `node clone`, `node loop`) keep
// it for the bare group; their subcommands get an entry here.
//
// 🔴 Coverage is enforced from the dispatch table, not from this list:
//    src/subcommand-help-coverage.test.ts walks `switch (command)` and every
//    handler's `switch (sub)` / `sub === "x"` and runs `--help` + `-h` for each.
//    Adding a subcommand without an entry here turns that test red.

const NODE_REF = "<node-id|node-name>";

export const NODE_DELETE_USAGE = `Usage: anet node delete ${NODE_REF} [--force]
       anet node delete <node_id> --hub-only [--hub <url>]

Stop the node, delete its local config (.anet/nodes/<id>/), then remove its
row on the Hub so it no longer shows as offline.

  --force       Required to actually delete (without it, prints what would go)
  --hub-only    Only remove the Hub row (the retry command printed when the Hub
                could not be reached); takes the node_id from that warning
  --hub <url>   Hub to use with --hub-only (default: your login's Hub)

The Hub row is matched by node_id only — never by name — so a node elsewhere
that reuses the same name is left untouched.
If the Hub is unreachable or refuses, the local files are still deleted, a
warning prints the exact retry command, and the exit code is 1.`;

/** path (space-joined) → usage text. `{cmd}` is replaced by the word the user typed (hub/server). */
export const COMMAND_HELP: Record<string, string> = {
  // ── node ──
  "node": `Usage: anet node <command> [name] [options]

Commands:
  create <name>                 Create a new agent node
  clone <src> <new>             Copy a node's settings under a new identity
  start <name>                  Start a node (--tmux, --copresence, --all …)
  stop <name>                   Stop a running node
  restart <name>                Stop then start a node
  resume <name>                 Resume an interrupted session
  delete <name> --force         Delete a node locally and on the Hub
  rename <ref> <new>            Rename a node
  edit <ref>                    Change a node's runtime, model or workdir
  loop <name> ...               Schedule a recurring goal on a node
  ls                            List nodes in this directory
  codex <verb> <ref>            Codex TUI co-presence lifecycle
  migrate-token-to-envref <n>   Move a node's token out of config.json into .env

Run 'anet node <command> --help' for details.`,
  "node create": `Usage: anet node create <name> [options]

Create a new agent node in ./.anet/nodes/<name>/ and register it on the Hub.

Options:
  --runtime <id>         claude-agent-sdk (default) | claude-code-cli | codex-sdk |
                         codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
                         cursor-agent
                         (aliases: grok = grok-build-acp, cursor-cli = cursor-agent)
  --model <id>           Model for the runtime
  --tools <list>         Extra tools to enable (e.g. WebSearch)
  --copresence           Shared human + agent TUI (codex-app-server / opencode-cli / grok)
  --env KEY=VALUE        Environment for the node (stored as an env ref, repeatable)
  --channel <spec>       Attach a channel (repeatable)
  --resume <id>          Bind an existing Claude session
  --resume-latest        Bind the latest Claude session
  --from <node>          Copy another node's settings (same as anet node clone)
  --batch                Batch-create wizard

Example:
  anet node create my-agent --runtime claude-agent-sdk`,
  "node stop": `Usage: anet node stop ${NODE_REF}

Stop a running agent node and tell the Hub it is offline.

On another machine (#562): add --remote — the Hub asks that machine's daemon to do it.
  anet node <start|stop|restart> <alias> --remote [--network <id|name>] [--yes] [--wait <s>]
  anet node edit <alias> --model <id> --remote [--network <id|name>] [--yes] [--wait <s>]`,
  "node restart": `Usage: anet node restart ${NODE_REF} [start options]

Stop the node, then start it again (same options as anet node start).

--force does not skip the start gate. Set ANET_START_MEM_GATE=0 to disable it.

On another machine (#562): add --remote — the Hub asks that machine's daemon to do it.
  anet node <start|stop|restart> <alias> --remote [--network <id|name>] [--yes] [--wait <s>]
  anet node edit <alias> --model <id> --remote [--network <id|name>] [--yes] [--wait <s>]`,
  "node resume": `Usage: anet node resume ${NODE_REF} [--session <session-id>]

Resume the node's interrupted session (or a specific one with --session).`,
  "node delete": NODE_DELETE_USAGE,
  "node rename": `Usage: anet node rename ${NODE_REF} <new-node-name> [--force]

Rename a node. --force is required for a running node: it is stopped and
restarted under the new name so it re-registers on the Hub.`,
  "node edit": `Usage: anet node edit ${NODE_REF} [--runtime <id>] [--model <id>] [--workdir <dir>]

Change a node's runtime, model or co-presence working directory (at least one flag).
Restart the node for the change to take effect.

On another machine (#562): add --remote — the Hub asks that machine's daemon to do it.
  anet node <start|stop|restart> <alias> --remote [--network <id|name>] [--yes] [--wait <s>]
  anet node edit <alias> --model <id> --remote [--network <id|name>] [--yes] [--wait <s>]`,
  "node ls": `Usage: anet node ls [--verbose]
       anet node list

List the nodes in this directory's .anet/nodes/ and whether they are running.`,
  "node migrate-token-to-envref": `Usage: anet node migrate-token-to-envref <node-name>

Move the node's token out of config.json into the node's .env file and leave an
env reference in config.json.`,
  "node codex": `Usage: anet node codex <verb> <alias> [options]
       anet node codex              (no arguments: interactive menu in a terminal;
                                     piped: the node table + a cheat sheet)

Codex TUI co-presence lifecycle. Verbs:
  anet node codex preflight <alias>   Read-only consistency check
  anet node codex verify <alias>      preflight + process/env + identity checks
  anet node codex canary <alias>...   verify each, stop at the first FAIL
  anet node codex start <alias>       Start App Server → TUI → Bridge, then verify
  anet node codex restart <alias>     Deterministic stop + start + verify
  anet node codex resume <alias> --thread <id>
  anet node codex fork <source> --name <target> --workdir <dir>
  anet node codex adopt <new-name> --thread <id> [--from-home <dir>]
  anet node codex account <register|list|install> ...
  anet node codex rollback <alias> --receipt <id>
  anet node codex login-status [--json]   Every codex node here: logged in? shared login?

Exit codes: 0 = PASS, 2 = FAIL or usage error.`,
  "node codex preflight": `Usage: anet node codex preflight <alias> [--json]

Read-only check: alias↔node_id, CODEX_HOME/auth, workdir, exact thread + one rollout,
port ownership, tmux topology. Writes a receipt; exit 0 = PASS, 2 = FAIL.`,
  "node codex verify": `Usage: anet node codex verify <alias> [--json] [--probe-from <peer>]

preflight plus child-process environment and cross-node identity checks.
Exit 0 = PASS, 2 = FAIL.`,
  "node codex canary": `Usage: anet node codex canary <alias>... [--probe-from <peer>]

Run verify on each alias in order; stop at the first FAIL. Run it before a batch
restart or an account change.`,
  "node codex start": `Usage: anet node codex start <alias> [--probe-from <peer>] [--probe-root <dir>]

Like restart, but requires that none of App Server / TUI / Bridge is running.`,
  "node codex restart": `Usage: anet node codex restart <alias> [--probe-from <peer>] [--probe-root <dir>]

Deterministic restart: preflight → stop Bridge, TUI, App Server → start them in
order → verify.`,
  "node codex resume": `Usage: anet node codex resume <alias> --thread <36-char thread id>

Write the exact thread into the config (needs exactly one rollout), then start.`,
  "node codex fork": `Usage: anet node codex fork <source> --name <target> --workdir <dir> [options]

Fork a Codex co-presence node: the history is inherited; node_id, CODEX_HOME,
thread, port and tmux names are new. The source node is not touched.

Options:
  --model <id>                  Override the source model
  --inherit-full-access         Keep the source's full-access grant
  --no-codex-login              Do not copy any login (log in before first start)
  --allow-shared-codex-login    Copy the source's auth.json (unsafe: the two
                                nodes will log each other out)

Then: cd <dir> && anet node codex start <target> --probe-from <source>`,
  "node codex adopt": `Usage: anet node codex adopt <new-name> --thread <id-or-unique-prefix> [options]

Turn a Codex TUI conversation started outside anet (a thread in ~/.codex, or in
any CODEX_HOME) into a new Codex co-presence node. Only that one rollout is
copied, with its thread id and cwd rewritten; node_id, CODEX_HOME, port and tmux
names are new. The source home is only read, never changed.

Options:
  --thread <id>                 Full thread id or a unique prefix (≥ 4 chars).
                                Without it: a TTY picks from a list; otherwise
                                the list is printed and the exit code is 2
  --from-home <dir>             The CODEX_HOME to read (default: ~/.codex)
  --workdir <dir>               Where the node lives (default: current directory)
  --model <id>                  Model (default: the conversation's last model)
  --no-codex-login              The default: no login is copied
  --allow-shared-codex-login    Copy the source's auth.json (unsafe: the source
                                and the node will log each other out)

Then: CODEX_HOME=<node dir>/codex-home codex login --device-auth
      anet node codex start <new-name>`,
  "node codex account": `Usage: anet node codex account register <profile-id> --from-codex-home <dir>
       anet node codex account list
       anet node codex account install <alias> --source codex-login:<profile-id> [--probe-from <peer>]

Manage Codex logins in the local registry; install backs up, installs, restarts
and verifies, and rolls back on failure.`,
  "node codex rollback": `Usage: anet node codex rollback <alias> --receipt <id> [--probe-from <peer>]

Restore the backup recorded in an install receipt.`,
  "node codex login-status": `Usage: anet node codex login-status [--json]

One row per codex node in this directory: alias, runtime, CODEX_HOME, logged in,
account (e-mail or fingerprint), and which other nodes share the same login (same
refresh-token chain: they log each other out, #1918). Read-only; never prints a token.
A node without a login logs in on its own: CODEX_HOME=<its codex-home> codex login [--device-auth]`,

  // ── legacy top-level aliases of node commands ──
  "create": `Usage: anet create <name> [options]

Legacy alias of 'anet node create'. See: anet node create --help`,
  "start": `Usage: anet start <name> [options]

Legacy alias of 'anet node start'. See: anet node start --help`,
  "stop": `Usage: anet stop ${NODE_REF}

Legacy alias of 'anet node stop'.`,
  "resume": `Usage: anet resume ${NODE_REF} [--session <id>]

Legacy alias of 'anet node resume'.`,
  "rename": `Usage: anet rename ${NODE_REF} <new-node-name> [--force]

Legacy alias of 'anet node rename'.`,
  "delete": `Usage: anet delete ${NODE_REF} [--force]

Legacy alias of 'anet node delete'. See: anet node delete --help`,
  "ls": `Usage: anet ls [--verbose]
       anet list

List the nodes in this directory (same as anet node ls).`,

  // ── single commands ──
  "attach": `Usage: anet attach <node-name>

Attach this terminal to the node's exact tmux TUI session.`,
  "info": `Usage: anet info <node-name>

Show a node's local config and its status on the Hub.`,
  "logs": `Usage: anet logs <node-name> [--follow] [--lines <n>]

Show a node's recent agent logs; --follow keeps tailing.`,
  "status": `Usage: anet status

Network overview: agents and recent tasks on the Hub you are logged in to.`,
  "tasks": `Usage: anet tasks [status] [--status <s>] [--limit <n>]

Query tasks on the Hub (status: delivered | replied | failed …).`,
  "init": `Usage: anet init [--hub <url>]
       anet init --hub <url> --token <tok>   (legacy master-token path)
       anet init project
       anet init profile

Configure the Hub URL in ~/.anet/config.json (no token prompt).`,
  "init project": `Usage: anet init project

Set up the current directory as an anet project (channel plugin config).`,
  "init profile": `Usage: anet init profile

Create a node profile interactively.`,
  "setup": `Usage: anet setup

Install runtime dependencies and choose a runtime (interactive wizard).`,
  "upgrade": `Usage: anet upgrade [--channel latest|preview] [--dry-run] [--self] [--no-auto-self]

Upgrade all anet packages on the channel this install came from.`,
  "import": `Usage: anet import [alias] [--hub <url>]

Import sessions from CommHub into local node configs.`,
  "doctor": `Usage: anet doctor [--fix]

System diagnostic check (runtimes, Hub, config, permissions).`,
  "license": `Usage: anet license

Show license status and limits.`,
  "activate": `Usage: anet activate <license-key>

Activate a license key.`,
  "passwd": `Usage: anet passwd [--old <password>] [--new <password>]

Change your Hub account password.`,
  "register": `Usage: anet register [--hub <url>] [--username <u>] [--password <p>] [--email <e>]

Create a new account on the Hub (prompts for what is not given).`,
  "login": `Usage: anet login [--hub <url>] [--username <u>] [--password <p>]
       anet login --token <tok>

Log in to the Hub and save the session in ~/.anet/config.json.`,
  "logout": `Usage: anet logout

Revoke this login on the Hub, then remove the saved token.`,
  "whoami": `Usage: anet whoami

Show the current user, Hub and networks.`,
  "config": `Usage: anet config            Show a config summary (secrets masked)
       anet config path       Print the config file path
       anet config json       Print the config as JSON (secrets masked)`,
  "config path": `Usage: anet config path

Print the path of ~/.anet/config.json.`,
  "config json": `Usage: anet config json

Print ~/.anet/config.json as JSON with secrets masked.`,
  "run": `Usage: anet run [--hub <url>] [--alias <name>]

Run a standalone SSE agent listener.`,
  "version": `Usage: anet version   (also: anet -v, anet -V, anet --version)

Print the anet version and a dependency report.`,
  "quickstart": `Usage: anet quickstart   (removed, see #45)

Use instead:
  anet hub start
  anet setup
  anet register
  anet login
  anet node create <name>`,
  "skill": `Usage: anet skill list [--verbose]
       anet skill show <slug>

Browse public SkillHub skills.`,
  "skill list": `Usage: anet skill list [--verbose]
       anet skill ls

List public SkillHub skills.`,
  "skill show": `Usage: anet skill show <slug>

Print a skill's SKILL.md (sha256 verified).`,
  "demo": `Usage: anet demo [ls]
       anet demo <debate|socialmedia|pr-review|sci-team> [options]

List or launch demos.`,
  "demo ls": `Usage: anet demo ls
       anet demo list

List the available demos.`,
  "demo debate": `Usage: anet demo debate [options]

Launch the debate demo.`,
  "demo socialmedia": `Usage: anet demo socialmedia [options]
       anet demo social

Launch the social-media demo.`,
  "demo pr-review": `Usage: anet demo pr-review [options]

Launch the PR-review demo.`,
  "demo sci-team": `Usage: anet demo sci-team [options]

Launch the science-team demo.`,

  // ── hub / server ──
  "hub start": `Usage: anet {cmd} start [--port <p>] [--host <h>] [--version <v>] [--channel latest|preview]
                       [--username <u>] [--password <p>] [--dev-open]
       anet {cmd} local   (alias)

Start the CommHub Server and bootstrap the admin account (log in separately).`,
  "hub stop": `Usage: anet {cmd} stop [--port <p>]

Stop the running CommHub Server (SIGTERM → 3s grace → SIGKILL).`,
  "hub status": `Usage: anet {cmd} status [--port <p>]

Show the hub PID, port and /health version.`,
  "hub dashboard": `Usage: anet {cmd} dashboard [--port <p>] [--ip <addr>]
       anet {cmd} dash   (alias)

Start the Web Dashboard.`,
  "hub config": `Usage: anet {cmd} config [options]

Show or set the server config (~/.anet/server/config.json).`,
  "hub admin": `Usage: anet {cmd} admin reset-user --username <user>

Reset a user's password directly in the local Hub database (run on the Hub host).`,

  // ── project ──
  "project up": `Usage: anet project up [--stagger <s>] [--only a,b] [--exclude x,y]

Start every node in this directory (already-running ones are skipped).`,
  "project restart": `Usage: anet project restart [--stagger <s>] [--only a,b] [--exclude x,y]

Kill any existing tmux session and start every node fresh.`,
  "project down": `Usage: anet project down [--only a,b] [--exclude x,y]

Stop every node in this directory and tell the Hub they are offline.`,
  "project ls": `Usage: anet project ls
       anet project list

List the nodes in this directory with their run state.`,

  // ── daemon ──
  "daemon adopt": `Usage: anet daemon adopt <alias> [--daemon <id-or-alias>] [--yes]
       anet daemon adopt --all [--daemon <id-or-alias>] [--yes]

Plan adoption from the current workdir. --yes requests a binding; the daemon
must independently verify it. Does not stop or restart the node. Human login required.`,
  "daemon unadopt": `Usage: anet daemon unadopt <alias> [--yes]

Plan binding revocation. --yes applies it; the running node is never stopped.
Human login required.`,
  "daemon adopted": `Usage: anet daemon adopted [--daemon <id>]

List local adopted entries with an active Hub binding. Run from the daemon
workdir with a human login. Does not modify nodes or bindings.`,
  "daemon init": `Usage: anet daemon init <name> [--force] [--allow-secret KEY]...

Create a host_supervisor daemon node config. --force overwrites a non-daemon
config of the same name, or re-runs init on an existing daemon to add newly
supported runtimes (keeps node_id, re-issues the token; restart it afterwards).`,
  "daemon start": `Usage: anet daemon start <name>

Start an existing daemon (verifies role=host_supervisor, then anet node start).`,
  "daemon restart": `Usage: anet daemon restart <name>

Stop then start a daemon (needed after an upgrade or a config change).`,
  "daemon up": `Usage: anet daemon up [name]

init + start in one step (default name: "daemon").`,
  "daemon list": `Usage: anet daemon list
       anet daemon ls

List locally configured daemon nodes (configuration only, not liveness).`,

  // ── network ──
  "network ls": `Usage: anet network ls
       anet network list

List your networks.`,
  "network create": `Usage: anet network create <name> [--description <desc>]

Create a new network.`,
  "network use": `Usage: anet network use <name>

Switch the default network for this login.`,
  "network info": `Usage: anet network info

Show the current network's details and stats.`,
  "network rename": `Usage: anet network rename <old> <new>

Rename a network.`,
  "network delete": `Usage: anet network delete <name> --force

Delete a network.`,
  "network invite": `Usage: anet network invite

Generate an invite code for the current network.`,
  "network join": `Usage: anet network join <code>

Join a network with an invite code.`,
  "network members": `Usage: anet network members

List the members of the current network.`,

  // ── channel ──
  "channel add": `Usage: anet channel add <type> <node-id> [options]
       anet channel add telegram <node-id> --bot-token <tok> --allow <uid>

Add a channel (telegram, feishu, …) to a node.`,
  "channel allow": `Usage: anet channel allow feishu <node-id> [--add-from <id>] [--add-chat <id>] [--rm-from <id>] [--rm-chat <id>]

Manage a feishu channel's allowFrom / allowChats (flags repeatable).`,
  "channel ls": `Usage: anet channel ls [node-id]

List channels (with allowFrom / allowChats for feishu).`,
  "channel status": `Usage: anet channel status [node-id]

Show the resolved access.json path, the allowlist and pending pairings.`,

  // ── session ──
  "session ls": `Usage: anet session ls
       anet session list

List Claude Code sessions for the current project.`,

  // ── goal ──
  "goal list": `Usage: anet goal list [node]
       anet goal ls [node]

List scheduled goals for one node, or for all nodes.`,
  "goal show": `Usage: anet goal show <node> <goal-id>

Show one goal in detail, including its progress log.`,
  "goal wake-log": `Usage: anet goal wake-log <node> <goal-id> [--json] [--tail N]
       anet goal wakelog ...

Export a goal's progress_log (wake history).`,
  "goal edit": `Usage: anet goal edit <node> <goal-id> [--interval <5min|1h|1d|…>] [--text "<goal>"] [--status active|paused|completed|cancelled]

Edit a goal (at least one flag). Restart the node for the change to take effect.`,
  "goal cancel": `Usage: anet goal cancel <node> <goal-id>

Mark a goal cancelled in that node's goals.json.`,

  // ── token ──
  "token create": `Usage: anet token create --name <name>
       anet token create <name>   (legacy positional form)

Create a new API token. The full token is printed once.`,
  "token revoke": `Usage: anet token revoke <token-id>

Revoke an API token by its ID.`,

  // ── batch ──
  "batch start": `Usage: anet batch start <prefix>

Re-launch every node of a batch group.`,
  "batch stop": `Usage: anet batch stop <prefix>

Stop every tmux session matching <prefix>-*.`,
  "batch restart": `Usage: anet batch restart <prefix>

Stop then start a batch group.`,
  "batch cleanup": `Usage: anet batch cleanup <prefix> --workdir <path>

Stop the group and remove <workdir>/node*/.`,
  "batch list": `Usage: anet batch list

List active batch groups.`,

  // ── grok ──
  "grok attach": `Usage: anet grok attach <node>

Attach this terminal to a grok co-presence node (Ctrl-] detaches).`,
  "grok model": `Usage: anet grok model <node> <model>

Switch a grok node's model; works while attached.`,

  // ── opencode ──
  "opencode upgrade-pin": `Usage: anet opencode upgrade-pin <version>

Reinstall and smoke-test the exact pinned opencode-ai release.`,
  "opencode auth-login": `Usage: anet opencode auth-login <node> --provider <anthropic|openai>

API-key login for an opencode-cli node, done in a throwaway private HOME.`,
};

/** Subcommand spellings that share a help entry. */
const HELP_ALIASES: Record<string, string> = {
  "list": "ls",
  "node list": "node ls",
  "hub local": "hub start",
  "hub dash": "hub dashboard",
  "project list": "project ls",
  "daemon ls": "daemon list",
  "network list": "network ls",
  "session list": "session ls",
  "goal ls": "goal list",
  "goal wakelog": "goal wake-log",
  "skill ls": "skill list",
  "demo list": "demo ls",
  "demo social": "demo socialmedia",
};

/** Top-level words that are aliases of another group; `{cmd}` renders as the word typed. */
const GROUP_ALIASES: Record<string, string> = { server: "hub" };

function render(text: string, typed: string): string {
  return text.replaceAll("{cmd}", typed);
}

/**
 * The most specific help entry for argv (e.g. ["node","delete","x","--help"]).
 * Only the leading positional words are the command path; the longest prefix
 * with an entry wins. `minDepth` lets the caller skip bare group entries when a
 * richer group printer exists in bin/cli.ts.
 */
export function lookupCommandHelp(argv: string[], minDepth = 1): string | null {
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) break;
    words.push(a);
  }
  if (!words.length) return null;
  const typed = words[0]!;
  const path = [GROUP_ALIASES[typed] ?? typed, ...words.slice(1)];
  for (let n = Math.min(path.length, 4); n >= minDepth; n--) {
    const key = path.slice(0, n).join(" ");
    const hit = COMMAND_HELP[key] ?? COMMAND_HELP[HELP_ALIASES[key] ?? ""];
    if (hit !== undefined) return render(hit, typed);
  }
  return null;
}
