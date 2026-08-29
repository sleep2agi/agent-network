# opencode-copresence serve-exit design note (#1451 finding #2)

**Pinned to `origin/main = 4f9d51f2` (2026-08-30).** Re-read the cited lines against the current tree before acting on this — if the file has moved, the description of the failure mode is stale.

## The finding, restated

`agent-node/src/runtime/opencode-copresence/runtime.ts:589`:

```ts
child.once("exit", (code, signal) => {
  if (!closed) warn(`[opencode-copresence] serve exited code=${code} signal=${signal}; next task must reopen`);
});
```

When `opencode serve` exits mid-life (crash, OOM, host restart, opencode upgrade), the runtime does exactly one observable thing: emits a warn line. Nothing else recovers state.

The next inbound task then reaches `ensureOpencodeCopresenceRuntime` in `agent-node/src/cli.ts:3335`:

```ts
if (opencodeCopresenceSession?.isRunning) return opencodeCopresenceSession;
// … cleanup …
opencodeCopresenceSession = null;
// … openOpenCodeCopresenceRuntime({...})   // <-- new opencode serve, new session id
```

Which spawns a **fresh** `opencode serve` and gets a **new** session id back from `POST /session`. The runtime's `onSession` callback overwrites `opencodeSessionId` and calls `writebackSession(id)`, so the node's config now points at the new session.

**But the human TUI is attached to the old, dead session id** (via `opencode-attach.sh` written at open time). It has no signal that the server it was talking to is gone, and no way to follow the node onto the new session.

## Why the other two co-presence runtimes don't have this shape

- **grok** (`agent-node/src/runtime/grok-build-acp/resume-hint.ts`, 194L): on resume, the runtime prepends a curated context block to the LLM's next prompt naming any outbound tasks that were in-flight when it stopped. The session identity is durable (grok owns it), and the network side survives a restart.
- **codex-app-server** (`agent-node/src/runtime/codex-app-server/runtime.ts:116, 211`): a persisted `codexThreadId` is loaded on boot; the bridge either resumes that exact thread on `codex app-server` or falls back to a fresh one and writes the adopted id back. The human `codex --remote` TUI is attached to the same thread the network side just resumed — so a serve restart is invisible to the human.

opencode has neither. The 1.18.1 REST surface (per its OpenAPI `/doc`) does expose `POST /session` and `GET /session/:id`, but does not offer a way for a client to "attach me to whatever id is currently live" — the id is what identifies the session and the TUI's attach script bakes it in.

## Should this be fixed by adding resume?

**Recommendation: NOT NOW, and the tradeoff is worth stating explicitly rather than filed away.**

**Arguments for adding resume:**

- Consistency with grok + codex — makes the three co-presence runtimes shaped the same way; less lore to remember.
- Serve exits happen for benign reasons (opencode binary upgrade, disk full then freed, host reboot in a cluster) and a silent orphan is a bad UX for the human.

**Arguments against, at current data:**

1. **The observable frequency is unknown.** No one has produced a case where a human TUI silently went dark on us because of a serve exit — the finding is a code-read, not a report. Fixing a rare unmeasured problem carries the risk that the fix introduces a more common one.
2. **The 1.18.1 REST surface does not offer a clean resume primitive.** Any attempt to bind the human TUI to a different session id post-hoc requires either (a) coordination through the TUI's own state — which opencode 1.18.1 does not expose as an API — or (b) killing the human TUI on serve exit and letting a wrapper script reopen it against the new session. Option (b) is a materially different UX from what humans get today (a stable TUI window across restarts) and needs a decision, not a quiet ship.
3. **The current outage mode is at least loud.** The warn line lands in the node log with a specific string; adding a resume shim also adds the failure modes of the shim itself.

**Proposed instead:** add a lightweight signal at the *observation* level, not the *recovery* level:

- On the `child.once("exit")` handler, in addition to the warn, publish a notice to CommHub — one line naming the exited session id and that the human TUI on that node is now orphaned. Cheap (~5 lines), gives fleet observers a chance to react manually, does not touch the resume gap.

This is a smaller step than resume and it makes the frequency measurable — after a few weeks we know whether this actually happens often enough to justify the resume design work.

## What was NOT done in this branch

- No live probe of the serve-exit path (would require killing `opencode serve` mid-session on a real node, and the dispatch red-line says 不碰生产 — a controlled probe on a fresh isolated node would need its own setup effort out of scope for this PR).
- No code change under finding #2. The signal-on-exit suggestion above is a follow-up if the fleet wants it.

## Related

- Finding #1 (`parseMessageReply` false failure) — fixed in this PR; witnessed-red covered in `agent-node/src/runtime/opencode-copresence/runtime.test.ts`.
- opencode 1.18.1 OpenAPI schema was probed (2026-08-30) against a fresh isolated install to confirm the `Message.parts` shape used by finding #1's tests.
