import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  diagnoseGrokCopresence,
  grokAttachSocketState,
  grokCopresenceRequested,
  grokCopresenceSessions,
  shouldPersistGrokCopresence,
  GROK_COPRESENCE_CHILD_ENV,
} from "./grok-copresence-orchestration.js";
import { copresenceDeps, missingCopresenceDeps } from "./copresence-deps.js";

describe("grok co-presence: session layout", () => {
  test("the attachable TUI owns the bare alias, like the codex lane", () => {
    // An operator should not need to know a node's runtime to know where to
    // attach. If this ever differs from codex, `tmux attach -t '=<alias>'`
    // silently lands on the bridge and the human sees log spam, not a TUI.
    expect(grokCopresenceSessions("研究马")).toEqual({ node: "研究马-桥", tui: "研究马" });
  });
});

describe("grok co-presence: readiness", () => {
  const sock = { isSocket: () => true };
  const file = { isSocket: () => false };

  test("ready only when the attach socket exists AND is a socket", () => {
    expect(grokAttachSocketState(sock)).toBe("ready");
  });

  test("a stale regular file left by an aborted run is NOT ready", () => {
    // This is the case that reads as ready to anything that only checks
    // existence — and existence is what a naive `-e` gate would check.
    expect(grokAttachSocketState(file)).toBe("not_a_socket");
  });

  test("no entry at all is missing, not ready", () => {
    expect(grokAttachSocketState(null)).toBe("missing");
    expect(grokAttachSocketState(undefined)).toBe("missing");
  });
});

describe("grok co-presence: diagnosis names every gap at once", () => {
  test("wrong runtime is named with the command that fixes it", () => {
    const d = diagnoseGrokCopresence({ runtime: "claude-code-cli", displayName: "甲" });
    expect(d.ok).toBe(false);
    expect(d.lines.join("\n")).toContain("--runtime grok-build-cli");
  });

  test("an explicitly headless node says which DECISION made it headless", () => {
    // "not supported" would send the operator looking for a missing feature;
    // the truth is they opted out at create time.
    const d = diagnoseGrokCopresence({
      runtime: "grok-build-cli", displayName: "乙", grokCopresence: false, grokAttachSocket: "/run/a.sock",
    });
    expect(d.ok).toBe(false);
    expect(d.lines.join("\n")).toContain("--grok-headless");
  });

  test("a missing attach socket is reported, and refuses to guess", () => {
    const d = diagnoseGrokCopresence({ runtime: "grok-build-cli", displayName: "丙", grokCopresence: true });
    expect(d.ok).toBe(false);
    expect(d.lines.join("\n")).toContain("grokAttachSocket");
  });

  test("two problems produce TWO reports in one run, not one exit", () => {
    // Whack-a-mole is the failure this shape exists to prevent: fix the runtime,
    // rerun, only then learn the socket is missing too.
    const d = diagnoseGrokCopresence({ runtime: "grok-build-cli", displayName: "丁", grokCopresence: false });
    expect(d.lines.filter((l) => l.includes("❌")).length).toBe(2);
  });

  test("a healthy node produces no lines at all", () => {
    const d = diagnoseGrokCopresence({
      runtime: "grok-build-cli", displayName: "戊", grokCopresence: true, grokAttachSocket: "/run/a.sock",
    });
    expect(d).toEqual({ ok: true, lines: [] });
  });
});

describe("grok co-presence: when a bare `anet node start` should do it", () => {
  const grok = { runtime: "grok-build-cli" };
  test("the flag turns it on for this run", () => {
    expect(grokCopresenceRequested(true, grok)).toBe(true);
  });
  test("a remembered opt-in makes every later start a single command", () => {
    expect(grokCopresenceRequested(false, { ...grok, grokCopresenceAuto: true })).toBe(true);
  });
  test("🔴 grokCopresence alone must NOT trigger it — create sets that on every grok node", () => {
    // Reading grokCopresence here would silently change what `anet node start`
    // does for every grok node that already exists: foreground today, forked
    // into tmux tomorrow, unasked. Found by running the real command without
    // the flag and watching it enter the orchestration anyway.
    expect(grokCopresenceRequested(false, { ...grok, grokCopresence: true })).toBe(false);
  });
  test("a plain grok node with nothing recorded does not silently open a TUI", () => {
    expect(grokCopresenceRequested(false, grok)).toBe(false);
  });
  test("an explicit headless opt-out beats the flag", () => {
    // A stale ANET_GROK_COPRESENCE in someone's shell must not reopen a lane
    // the operator documented as closed.
    expect(grokCopresenceRequested(true, { ...grok, grokCopresence: false })).toBe(false);
  });
  test("a non-grok runtime is never routed here", () => {
    expect(grokCopresenceRequested(true, { runtime: "codex-app-server", grokCopresence: true })).toBe(false);
  });
});

describe("grok co-presence: dependency preflight", () => {
  const present = (...have: string[]) => (c: string) => have.includes(c);

  test("the grok lane probes grok, not codex", () => {
    const names = copresenceDeps(present("tmux", "bunx"), "linux", "grok").map((d) => d.name);
    expect(names).toContain("grok");
    expect(names).not.toContain("codex");
  });

  test("the codex lane is unchanged by the grok lane existing", () => {
    const names = copresenceDeps(present("tmux", "bunx"), "linux").map((d) => d.name);
    expect(names).toEqual(["tmux", "codex", "bunx"]);
  });

  test("a missing grok binary names an install command, not just advice", () => {
    const missing = missingCopresenceDeps(present("tmux", "bunx"), "linux", "grok");
    expect(missing.map((d) => d.name)).toEqual(["grok"]);
    expect(missing[0].install).toBeTruthy();
  });

  test("both lanes still need tmux and bunx — one table, no drift", () => {
    const missing = missingCopresenceDeps(present(), "linux", "grok").map((d) => d.name);
    expect(missing).toEqual(["tmux", "grok", "bunx"]);
  });
});

test("the recursion guard reuses the codex lane's variable, not a second name", () => {
  // Two names would be two guards to keep in sync by hand; cli.ts checks this
  // exact one before entering any co-presence orchestration.
  expect(GROK_COPRESENCE_CHILD_ENV).toBe("ANET_COPRESENCE_BRIDGE");
});

describe("grok co-presence: the CLI actually routes to it", () => {
  // 🔴 The pure module being correct proves nothing if cli.ts never calls it.
  //    That is exactly how the identical JSON.parse bug survived a fix in this
  //    same repo (#1102 → #1149): the helper was right, the call site was not
  //    looked at. Gate the wiring, in the file that does the wiring.
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");

  test("the dispatcher has a grok branch", () => {
    expect(cli).toContain('if (copresenceRuntime === "grok-build-cli")');
    expect(cli).toContain("await startGrokCopresenceOrchestration(");
  });

  test("the entry gate asks the grok lane, not only the codex lane", () => {
    // Without this the gate answers false for every grok node and the command
    // falls through to the codex orchestration, dying on
    // "requires runtime=codex-app-server" — the exact pre-fix behaviour.
    expect(cli).toContain("grokCopresenceRequested(copresenceFlagPassed");
  });

  test("no user-facing line still tells people to open a second terminal", () => {
    // Comments may quote the old wording as history; printed lines may not.
    const printed = cli.split("\n").filter((l) => /console\.(log|warn|error)/.test(l));
    expect(printed.filter((l) => /second terminal|Attach from another terminal/.test(l))).toEqual([]);
  });
});

describe("grok co-presence: remembering the choice", () => {
  const grok = { runtime: "grok-build-cli" };
  test("the flag is recorded so the next start needs none", () => {
    expect(shouldPersistGrokCopresence(true, grok)).toBe(true);
  });
  test("nothing is written when the flag was not passed", () => {
    expect(shouldPersistGrokCopresence(false, grok)).toBe(false);
  });
  test("no pointless rewrite when it is already recorded", () => {
    expect(shouldPersistGrokCopresence(true, { ...grok, grokCopresenceAuto: true })).toBe(false);
  });
  test("never recorded on a non-grok node", () => {
    expect(shouldPersistGrokCopresence(true, { runtime: "codex-app-server" })).toBe(false);
  });
});

test("the CLI records the opt-in before orchestrating", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  expect(cli).toContain("shouldPersistGrokCopresence(copresenceFlagPassed");
  expect(cli).toContain("grokCopresenceAuto: true");
});

test("the node session tees its output, so a dead session still explains itself", () => {
  // A leader that dies during startup takes its tmux session with it; naming
  // that session is advice pointing at something that no longer exists.
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  expect(cli).toContain("anet-grok-copresence-");
  expect(cli).toContain("What it printed");
});

test("hub auto-start forwards COMMHUB_DB into the tmux child", () => {
  // tmux hands the new session the tmux SERVER's environment, not this
  // process's. Verified: a hub started this way with COMMHUB_DB set served the
  // default database and never created the file COMMHUB_DB named.
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
  expect(cli).toContain("COMMHUB_DB=${process.env.COMMHUB_DB}");
});
