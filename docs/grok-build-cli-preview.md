# Grok Co-Presence Preview

## Status and boundary

`grok-build-cli` co-presence is a dangerous experimental candidate for the npm `preview` channel. It is not production-ready, is not part of `latest`, and must not be connected to untrusted tasks or an untrusted network. This lane uses the native Grok TUI directly; it does not use ACP and has no ACP fallback.

This guide describes the candidate source behavior. It does not assert that a particular npm `preview` dist-tag already contains the candidate; package publication remains gated on install-from-tarball testing, an independent review, and explicit release approval.

The main known risk is intentional and visible: CommHub tasks drive the same Grok TUI that a human uses, so both sides share one conversation context. The fixed preview tools are automatically approved; there is no per-call Yes/No boundary. Connect this runtime only to trusted tasks and a trusted network.

The formal native Leader/Policy Gateway runtime is a separate, stricter track. Its Phase 0 protocol freeze, Phase 1A implementation gate, approval-owner work, and `latest` release gate remain locked. This preview does not claim those capabilities.

## Verified candidate (2026-08-01)

The implementation source tested in Docker is commit
`8addab2cdcf231f4c078466acd091eaedddf5034`. It has not been merged or
published. The exact package candidate is deployed only to the local
`指挥狗` preview node for UAT.

The gates were run in order and all passed:

- [test219](tests/report-test219.txt): 293 checks, zero failures; native PTY,
  reducers, attach, arbitration, reply, approval, reconnect, and package builds.
- [test224](tests/report-test224.txt): network-disabled package and credential
  boundary; preview metadata, owner-only state, redaction, and zero synthetic
  marker leakage.
- [test225](tests/report-test225.txt): packed-package create/start/register/task,
  real tmux rendering, reply, stop/resume, and same-session continuity.
  Both the pinned keyless Grok 0.2.93 gate and the read-only-mounted real
  authenticated Grok gate passed. The run issued zero tmux input commands and
  performed zero publish actions. A separate local UAT then used
  `search_tool` and `use_tool` to execute CommHub `send_task`; it returned
  `ok: true`, and the same attached TUI completed a second human turn.

The authenticated scan reports a closed `scan_error` as a visible preview
structure warning. It did not find a credential match and is accepted only by
the explicit preview policy; it remains a blocker to claiming production or
`latest` readiness.

## Requirements

- Linux with procfs mounted at `/proc` (including `/proc/self/fd`).
- `@sleep2agi/agent-network` from the `preview` channel once the candidate is published.
- 一个**已黑盒验证过的** Grok CLI build。当前两个：`grok 0.2.93 (f00f96316d)` 与
  `grok 1.0.5 (5115b46bc9)`（两者的 ` [stable]` 后缀形式同样接受）——
  见 [`runtime.ts`](../agent-node/src/runtime/grok-copresence/runtime.ts) —— 搜 `requires a verified grok build`.
  (Symbol anchor, not a line number: #857 replaced 13 line pins here after finding **13 of 13 had drifted**.)
  🔴 这里**不是版本区间比较**：新 build 会改 PTY / 审批菜单 / Leader 契约
  （1.0.5 就把 folder trust 从「MCP + hooks」扩成「MCP + LSP + hooks 且级联子目录」，
  并新增了 13 格跨厂商 `externalCompat`）。加一个版本 = 先跑验证再往白名单加一行。

  🔴 **The unversioned installer does not give you this build.** `https://x.ai/cli/stable` returned
  `1.0.4` when #876 was filed and `1.0.5` on 2026-08-18 — it keeps moving, and the pin does not.
  Pass the version explicitly:

  ```bash
  curl -fsSL https://x.ai/cli/install.sh | bash -s 0.2.93
  grok --version   # must print: grok 0.2.93 (f00f96316d)
  ```

  `bash -s <version>` is the installer's own first positional argument (`TARGET="$1"`), so this is the
  supported path rather than a hand-assembled artifact URL. Measured 2026-08-18 in an isolated `HOME`:
  the command above printed `Grok 0.2.93 installed to …/.grok/bin/grok`, and `grok --version` printed
  `grok 0.2.93 (f00f96316d)` — byte-identical to the pinned string.

  🔴 That installer performs **no checksum verification** of what it downloads (`grep -nE 'sha256|checksum'`
  on it returns nothing). That is xAI's installer, not ours; it is stated here so the trust boundary is
  explicit rather than assumed.
- A completed Grok CLI login for the same operating-system user that runs `anet`.
- Two terminals on the same machine and user account: one owns the node process; one attaches to its local TUI socket.
- A trusted CommHub and trusted task senders.

Verify Grok before creating the node:

```bash
grok login
grok --version
```

The co-presence runtime fails closed when the version string does not match the pinned build.

## Shared-TUI quick start

Install the preview CLI when a reviewed preview package containing this runtime is available:

```bash
npm install -g @sleep2agi/agent-network@preview
```

Create and start the node in terminal 1:

```bash
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared
```

Attach terminal 2:

```bash
anet grok attach grok-shared
```

Press `Ctrl-]` to detach without stopping the node.

The default `grok-build-cli` profile created by `anet` enables co-presence. `anet node start` owns one Grok PTY and exposes a local, same-user attach socket. The attached terminal renders that TUI. A network task sent to `grok-shared` is submitted into the same session, appears in the TUI, and its completed answer is routed to the original CommHub task.

### Changing the tool profile requires a new session

Grok 0.2.93 fixes the available tool inventory when it creates a session. A
later config/profile change does **not** add or remove tools from that saved
session: a normal restart resumes the old capability set. This was reproduced
with a session created under the default profile; after its config was changed
to `WebSearch`, resuming the same session still had no `web_search` tool.

After changing between the default and `WebSearch` profiles, stop the node and
create a fresh Grok session explicitly:

```bash
anet node stop grok-shared
anet node start grok-shared --new-session
```

The old session data remains on disk, but the node config is updated to the new
session ID. The startup banner labels the configured profile and states whether
the command is creating a new session or resuming one. On resume it cannot
infer that an edited config matches the session's creation-time inventory, so
it warns instead of claiming the config change took effect.

The preview uses one runtime-owned, mode-`0600` agent profile selected with
the TUI-effective `--agent` flag. By default its exact model-tool inventory is
`[todo_write,search_tool,use_tool]`. The latter two expose only one
runtime-owned outbound-only CommHub MCP server; host and project MCP
definitions are never loaded. That MCP child exposes only `send_task`,
`send_message`, and `get_all_status`. It does not register a channel
capability, open an SSE/inbox connection, claim or acknowledge tasks, or report
lifecycle/presence. The outer `agent-node` process remains the single inbox and
lifecycle owner. Filesystem, shell, web, media, scheduler, and subagent tools
remain unavailable. One explicit process-level profile is also supported:

```bash
anet node create A站GrokTUI --runtime grok-build-cli --tools WebSearch
```

That exact configuration adds only `web_search` and removes the final
`--disable-web-search` switch. It remains without WebFetch, filesystem, shell,
media, scheduler, and subagent tools. This is general web-search access, not a
technically enforced x.com-only network sandbox; Grok can use it for basic X
URL/title/summary searches, but accurate likes/reposts and native XSearch are
not promised. Any other custom `tools` value is rejected. `maxTurns` is also
rejected because Grok 0.2.93 ignores it in interactive mode. The selected
profile is frozen at agent-node process startup and is never changed according
to the current human/network turn. The default text-only restriction lets the
pinned CLI read its existing owner-only login after sandbox re-exec without
giving a network prompt a model-tool route to that file. The CommHub server is
a self-contained package artifact staged below the isolated Grok home; its
credential snapshot lives in a separate owner-only credential directory and
is explicitly denied to model tools. This split is required because the
sandbox bind-hides project `.anet`, while release scans must prove credentials
never entered Grok session state. Use another runtime when code inspection,
editing, shell execution, WebFetch, or media access is needed.

Pinned Grok 0.2.93 wraps each fixed tool in a permission lifecycle. The runtime
starts the TUI with `--permission-mode bypassPermissions --always-approve`, so
the exact tools in the selected process profile proceed without a Yes/No prompt.
The runtime still accepts only their exact observed lifecycle tuples with
strict request/turn correlation. A network turn may use each exact tool tuple
at most once; human turns may repeat an exact tuple. Any other tool, decision,
identity shape, overlap, or unresolved completion closes the runtime. The
WebSearch opt-in therefore auto-approves general web search for both human
and network turns in that process. This is not a capability claim for `latest`.

### Human-turn and MCP lifecycle regressions (2026-08-01)

Grok 0.2.93 was observed emitting three consecutive exact `todo_write`
lifecycles for one human prompt. The earlier network-only gate, and then an
intermediate one-use human gate, both closed the Leader, attach socket, and TUI
after an otherwise valid automatic resolution. Commit `9c87d315` keeps the
network limit unchanged while admitting repeated exact lifecycles only for a
human-owned turn.

The regression tests were first run against the old conditions and failed.
One additional live failure showed that the sandbox correctly hid project
`.anet` but the generated MCP config incorrectly pointed inside that hidden
directory. The final candidate stages a self-contained server outside the
hidden project path while keeping the credential outside scanned TUI state.
With the fixes, Docker test219 passed 293 tests, test224 passed with networking
disabled, and the authenticated packed-package test225 passed. A live
`指挥狗` session called `search_tool`, invoked `use_tool`, sent a real CommHub
task, completed a second human prompt, and retained the
agent-node process, Leader socket, attach socket, and bridge.

The runtime prepares Grok's owner-only folder-trust store non-interactively,
but grants trust to the exact canonical working directory only. It first
refuses project MCP, LSP, hook, plugin, permission/sandbox configuration, and
`.envrc` sources that folder trust could activate; it never widens the grant
to a repository root, parent, symlink alias, home directory, or filesystem
root. This is why a normal start requires no simulated `y` keypress.

The preview package gate covers the CommHub inbox path. Feishu is explicitly
refused for `grok-build-cli` because its forked worker does not yet share this
runtime's credential-isolated log boundary; use a separate non-Grok node for
Feishu. Other optional channel adapters are outside this preview's package E2E.

There is no separate `--copresence` flag: co-presence is the default for a newly created `grok-build-cli` node. `--grok-headless` is the explicit opt-out described below.

## Agent-node package resolution

A global `agent-node` install is optional. Before starting `grok-build-cli`, `anet` checks for the machine-readable `ANET_CAPABILITY_GROK_COPRESENCE_V2` marker; merely advertising `grok-build-cli` or the older V1 co-presence marker is not sufficient. If the installed binary is absent or incompatible, `anet` uses:

```bash
npx -y @sleep2agi/agent-node@preview
```

The command is used only to fetch and resolve the package. `anet` then validates its preview metadata and capability marker and launches the resolved `agent-node` entrypoint directly, so the PID recorded for `anet node stop` belongs to the real runtime rather than the short-lived npm wrapper. It needs npm registry access or an already populated npm cache on first use. `anet` refuses an unsupported fallback rather than silently selecting a different runtime.

The npm resolver, long-lived `agent-node`, Grok probes, PTY, and lock helpers
each receive a separately reviewed environment built from an empty object.
The node credential is read from its owner-only profile instead of being put
in those environments. Ordinary logs, pending replies, and goal state cross a
shared redaction boundary; their durable files are mode `0600`. This is an
environment-inheritance boundary, not isolation from another process already
running as the same operating-system user; same-UID processes remain inside
the preview's trusted host boundary.

The preview binds the auto-spawned Leader to its Unix listener, process start
time, executable, isolated environment, and a per-spawn generation marker
before stopping it. Node does not expose Linux `pidfd_send_signal`, so the
final signal uses a numeric PID after revalidation. This leaves a syscall-sized
PID-reuse race with another same-UID process; it is part of the same trusted-
host limitation and is not a production isolation claim. The `latest` channel
remains separately blocked on its full native gateway and lifecycle review.

## Headless choices

There are two distinct headless paths.

### Legacy process-per-turn Grok CLI

```bash
anet node create grok-turn --runtime grok-build-cli --grok-headless
anet node start grok-turn
```

This launches one streaming-JSON Grok CLI turn per task. It has no shared interactive TUI, and `anet grok attach grok-turn` intentionally fails.

| Profile | Execution path | `anet grok attach` |
|---|---|---|
| `--runtime grok-build-cli` | shared human/network TUI | yes |
| `--runtime grok-build-cli --grok-headless` | one streaming-JSON CLI turn per task | no |

ACP is intentionally outside this implementation and is not used as a
fallback if the native TUI path fails.

## Preview safety rules

- Use only trusted task senders. A network task influences the same model and conversation visible in the human TUI.
- Do not use this runtime for production work or connect it to a public/untrusted Hub.
- The co-presence profile deliberately runs in immutable always-approve mode. It has no per-call human confirmation.
- Automatic approval is limited to the exact process profile. The default inventory is `todo_write`, `search_tool`, and `use_tool`. The explicit `--tools WebSearch` profile adds only general `web_search`; filesystem, shell, WebFetch/media, project/host MCP, and subagents remain unavailable.
- Search queries leave the machine and may contain text derived from the current conversation. Do not place secrets or private source material in a task sent to the WebSearch profile.
- Search results are untrusted model input and may contain prompt injection. The current blast radius is limited only because this profile still has no shell, filesystem, WebFetch/media, project/host MCP, or subagent tools. Adding any tool to this profile requires a fresh security review of that assumption.
- Grok children and runtime lock helpers receive exact, from-empty environment allowlists. CommHub/cloud credentials are not inherited by those processes.
- The shared-TUI preview has one of two exact inventories: `[todo_write,search_tool,use_tool]` or explicit `[todo_write,search_tool,use_tool,web_search]`. MCP access is limited to its single runtime-owned CommHub server. Do not treat either profile as a filesystem-, WebFetch/media-, subagent-, or shell-capable coding runtime.
- Folder trust is runtime-owned, mode `0600`, and contains exactly the current canonical working directory; project executable configuration is a startup error rather than implicitly trusted code.
- Known values loaded by the process and recognized credential shapes/assignments in network task text or replies are scrubbed before ordinary logs, status, pending replies, and external delivery. This is not a universal classifier for arbitrary opaque text: do not paste credentials into the shared conversation or TUI. The isolated Grok conversation transcript is the only owner-only raw transcript store: its directories are `0700` and regular files are `0600`; do not copy it into reports or support bundles.
- Do not infer `latest` support from this document. Promotion requires a separate review and release decision.

## Common errors

`grok copresence requires a verified grok build` 表示装着的 Grok 二进制不在已验证白名单里。
报错本身会列出当前已验证的 build。装其中一个；**不要绕过这个检查**：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash -s 0.2.93
grok --version   # grok 0.2.93 (f00f96316d)
```

### 1.0.5 与 0.2.93 的一处行为差异（会影响你读日志）

1.0.5 **不会**自动拉起 Leader 进程：厂商文档 `18-sandbox.md` 写明，只要请求了
非 `off` 的 sandbox profile，agent 就在**进程内**跑、并且**拒绝 leader**
（"still refuses the leader so tools are not delegated elsewhere"）。而共存永远请求
sandbox，所以在 1.0.5 上 `~/.grok/leader.sock` 与 `--leader-socket` 指向的路径都不会出现
socket —— 这是**预期**，不是故障。运行时按 build 记录了这一能力，并对相反情况
fail-closed：声明无 Leader 的 build 上真出现了 socket 会直接报错。

`Node ... uses legacy headless grok-build-cli mode` means the profile was created with `--grok-headless`. Create a new co-presence profile explicitly rather than editing socket/session fields by hand.

`grok attach requires an interactive TTY` means the attach command is running under redirected input/output. Run it from a real terminal on the same host and user account as the node.

`grok-build-cli refuses project executable configuration` means the working
tree contains a project MCP/LSP/hook/plugin/config/direnv source that Grok
folder trust could execute. Remove or isolate that source before using the
shared-TUI preview; the runtime will not click through or broaden trust.

If the TUI says CommHub is unavailable, inspect the owner-only MCP stderr log
under the node's isolated Grok home. A healthy start records `MCP stdio
connected`, `ready`, and registration for the node alias. Do not point the MCP
back at project `.anet`: that directory is intentionally bind-hidden.

If `anet` says the preview `agent-node` does not advertise `grok-build-cli`, the required preview package has not been published or cached yet. Do not force an older package to run the profile.

## Handoff

- Candidate branch: `fix/grok-tui-main-sync-3h`
- Clean worktree used for the candidate: `/tmp/commniu-grok-tui-3h`
- Tested source commit: `8addab2cdcf231f4c078466acd091eaedddf5034`
- Docker gates use the fixed tags `anet-test219:dev`, `anet-test224:dev`, and
  `anet-test225:dev`. The verified images were removed after report capture to
  protect shared-host disk space; rebuild the same fixed tags from the exact
  source commit when reproducing the run.
- The reports above are generated artifacts bound to the tested source commit.
  Do not relabel them after a source change; rerun 219, then 224, then 225.
- Remaining release work: independent review, an explicit preview release
  decision, and a reviewed npm preview publication. Do not self-merge or
  publish from this candidate.
