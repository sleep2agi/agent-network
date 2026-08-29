import { describe, expect, test } from "bun:test";
import {
  BLOCK_SUFFIX,
  waitFor,
  withHumanTui,
} from "./copresence-human-fixture";

// Behaviour snapshot of the human-side slash/permission-key gate as it exists
// on 2026-08-15. Every assertion below records WHAT THE CODE DOES TODAY, not
// what it ought to do. `/model` being unusable (see "experience cost" cases) is
// a known product complaint; this file exists so that when the gate is
// loosened, the diff shows exactly which behaviours moved.
//
// Each case is tagged:
//   SECURITY  - must stay red no matter how the gate is relaxed.
//   EXPERIENCE- the collateral damage; a future fix is expected to change it.
//   BOUNDARY  - proves the gate discriminates, i.e. is not a blanket block.
//
// The fixture lives in ./copresence-human-fixture and is copied from
// runtime.test.ts so every file drives the runtime the same way; the only
// addition is `warnings`, which captures the runtime's `warn` callback.

// On current main, a cursor-edited plain line is NOT refused at Enter:
// submission consults humanComposerLeadingSlash (column zero) and
// humanComposerAuditUnsafe only. The old 2026-08-15 snapshot (tainted ⇒
// refuse, and #881's lying "slash command" message) is retired; the cases
// below pin the surviving semantics so a future re-tightening shows up as a
// red diff instead of a silent regression.
const SLASH_ROUTE = "slash command";
const SLASH_TUI_NOTICE = "[anet] 斜杠命令在共存会话被禁用；换模型请另开终端: anet grok model <node> <model>";

// Keys that knownComposerNavigationLength() accepts and that therefore taint
// the composer audit. ABCDHF plus the `~` family; verified by running, not by
// reading the accept-list.
const TAINTING_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Left arrow", "\x1b[D"],
  ["Home", "\x1b[H"],
  ["End", "\x1b[F"],
  ["Delete", "\x1b[3~"],
];

describe("Grok copresence human-side slash gate (2026-08-15 snapshot)", () => {
  test("a leading-slash non-model command is cancelled with Ctrl-C and never reaches the TUI", async () => {
    await withHumanTui(async ({ fixture, input, runtime }) => {
      input.write("/plugins\r");
      await waitFor(() => fixture.warnings.some((line) => line.includes("slash command")));

      // The characters themselves are forwarded as typed (the human sees them
      // in Grok's editor); only the submit key is turned into a cancel.
      expect(fixture.writes.join("")).toBe("/plugins\x03");
      expect(fixture.warnings).toEqual([`[grok-copresence] slash command ${BLOCK_SUFFIX}`]);

      // Nothing was submitted: the fake TUI never produced a user turn.
      await Bun.sleep(120);
      expect(fixture.humanPrompts).toEqual([]);
      // The block does not leave the human owning the turn: arbitration is
      // pushed back to idle. See the issue #880 case at the end of this file
      // for what that costs.
      expect(runtime.state.phase).toBe("idle");
    });
  });

  test("/model is cancelled like other TUI slash commands and points to anet grok model", async () => {
    await withHumanTui(async ({ fixture, input, terminalOutput, statusWarnings }) => {
      input.write("/model grok-4-fast\r");
      await waitFor(() => terminalOutput.join("").includes(SLASH_TUI_NOTICE));

      expect(fixture.writes.join("")).toBe("/model grok-4-fast\x03");
      expect(fixture.acpModelSwitchCalls).toEqual([]);
      expect(fixture.spawnedArgs).toHaveLength(1);
      expect(fixture.warnings).toEqual([`[grok-copresence] slash command ${BLOCK_SUFFIX}`]);
      expect(statusWarnings).toContain(`slash command ${BLOCK_SUFFIX}`);
      expect(terminalOutput.join("")).toContain(SLASH_TUI_NOTICE);
    });
  });

  test("/model never falls through to restart+resume from the TUI slash gate", async () => {
    await withHumanTui(async ({ fixture, input, terminalOutput }) => {
      fixture.acpModelSwitch = async () => {
        const error = new Error("incompatible-agent: model requires new session");
        (error as Error & { code?: number }).code = -32000;
        throw error;
      };

      input.write("/model grok-4.5\r");
      await waitFor(() => terminalOutput.join("").includes(SLASH_TUI_NOTICE));

      expect(fixture.writes.join("")).toBe("/model grok-4.5\x03");
      expect(fixture.acpModelSwitchCalls).toEqual([]);
      expect(fixture.spawnedArgs).toHaveLength(1);
      expect(fixture.warnings).toEqual([`[grok-copresence] slash command ${BLOCK_SUFFIX}`]);
    });
  });

  test("a tainted /model line is blocked before it can use ACP or restart", async () => {
    await withHumanTui(async ({ fixture, input }) => {
      input.write("/model grok-4-fast");
      await Bun.sleep(40);
      input.write("\x1b[D");
      await waitFor(() => fixture.warnings.some((line) => line.includes("editor navigation")));

      expect(fixture.acpModelSwitchCalls).toEqual([]);
      expect(fixture.spawnedArgs).toHaveLength(1);
      expect(fixture.writes.join("")).toBe("/model grok-4-fast\x03");
    });
  });

  // SECURITY. This is the red gate. `/always-approve` would make the shared TUI
  // pre-authorised for every later NETWORK turn, so any future scheme that lets
  // `/model` through must keep this exact case blocked.
  test("a /always-approve submit is cancelled, warned about, and visible to the attached human", async () => {
    await withHumanTui(async ({ fixture, input, terminalOutput, statusWarnings }) => {
      input.write("/always-approve\r");
      await waitFor(() => fixture.warnings.some((line) => line.includes("slash command")));

      expect(fixture.writes.join("")).toBe("/always-approve\x03");
      expect(fixture.warnings).toEqual([`[grok-copresence] slash command ${BLOCK_SUFFIX}`]);

      // The block is not silent: it is broadcast to the attached terminal.
      await waitFor(() => statusWarnings.some((line) => line.startsWith("slash command was blocked")));
      expect(statusWarnings).toContain(`slash command ${BLOCK_SUFFIX}`);
      await waitFor(() => terminalOutput.join("").includes(SLASH_TUI_NOTICE));
      expect(terminalOutput.join("")).toContain(`\r\n${SLASH_TUI_NOTICE}\r\n`);

      await Bun.sleep(120);
      expect(fixture.humanPrompts).toEqual([]);
    });
  });

  // BOUNDARY. Ordinary prose submits normally. Proves the gate is not "block
  // every Enter"; whatever replaces it must keep this path warning-free.
  test("plain text without a leading slash submits normally and raises no warning", async () => {
    await withHumanTui(async ({ fixture, input }) => {
      input.write("hello world\r");
      await waitFor(() => fixture.humanPrompts.includes("hello world"));

      expect(fixture.writes.join("")).toBe("hello world\r");
      expect(fixture.warnings).toEqual([]);
    });
  });

  // BOUNDARY. humanComposerLeadingSlash is only true at column zero, so a slash
  // inside prose is NOT treated as a command. Confirmed by running: `see a/b`
  // submits. (It does set humanComposerSawSlash, which matters for the
  // navigation case below.)
  test("a slash in the middle of prose is not treated as a command and submits", async () => {
    await withHumanTui(async ({ fixture, input }) => {
      input.write("see a/b\r");
      await waitFor(() => fixture.humanPrompts.includes("see a/b"));

      expect(fixture.writes.join("")).toBe("see a/b\r");
      expect(fixture.warnings).toEqual([]);
    });
  });

  // EXPERIENCE. Read this one against the case directly above: the SAME text,
  // `see a/b`, submits fine but cannot be edited. Enter consults
  // humanComposerLeadingSlash (column zero only), while the navigation guard
  // consults humanComposerSawSlash (anywhere in the line), so pressing Left to
  // fix a typo destroys the whole composer. The warning says "after slash
  // input", which the human is unlikely to connect to a slash typed a dozen
  // characters earlier. Snapshot of 2026-08-15; recording the inconsistency,
  // not endorsing it.
  test("arrow keys are refused after a mid-prose slash, so the same text cannot be edited", async () => {
    await withHumanTui(async ({ fixture, input, runtime }) => {
      input.write("see a/b");
      await waitFor(() => runtime.state.phase === "human_editing");
      expect(fixture.warnings).toEqual([]);

      // The human reaches for Left to correct a typo, not to recall history.
      input.write("\x1b[D");
      await waitFor(() => fixture.warnings.some((line) => line.includes("editor navigation")));

      // The whole line is gone: cursor key withheld, Ctrl-C appended instead.
      expect(fixture.writes.join("")).toBe("see a/b\x03");
      expect(fixture.writes.join("")).not.toContain("\x1b[D");
      expect(fixture.warnings).toEqual([
        `[grok-copresence] editor navigation after slash input ${BLOCK_SUFFIX}`,
      ]);
      await Bun.sleep(120);
      expect(fixture.humanPrompts).toEqual([]);
      expect(runtime.state.phase).toBe("idle");
    });
  });

  // BOUNDARY + #881. No slash anywhere: one cursor key must not make the line
  // unsendable, and no refusal message may appear (so it cannot lie about a
  // slash command either).
  test("a cursor-edited plain line submits, with no warning and no slash blame (#881 resolved by not refusing)", async () => {
    await withHumanTui(async ({ fixture, input, runtime, terminalOutput, statusWarnings }) => {
      input.write("hello");
      await waitFor(() => runtime.state.phase === "human_editing");

      // The cursor key IS forwarded: the caret really moves in Grok's editor.
      input.write("\x1b[D");
      await Bun.sleep(120);
      expect(fixture.warnings).toEqual([]);
      expect(fixture.writes.join("")).toBe("hello\x1b[D");

      input.write("\r");
      await waitFor(() => fixture.humanPrompts.length > 0);

      // Enter goes through: the edited line reaches the TUI, nothing is
      // cancelled, and no message — least of all a "slash command" one — is
      // emitted. This is the #881 end-state: the lying refusal cannot occur
      // because there is no refusal.
      expect(fixture.writes.join("")).toBe("hello\x1b[D\r");
      expect(fixture.warnings).toEqual([]);
      expect(fixture.warnings.join("")).not.toContain(SLASH_ROUTE);
      expect(statusWarnings).toEqual([]);
      expect(terminalOutput.join("")).not.toContain(SLASH_TUI_NOTICE);
    });
  });

  // BOUNDARY. Home/End/Delete are in the same accept-list as the arrow keys
  // (ABCDHF plus the `~` family). None of them may cost the human the line:
  // navigation on a slash-free composer is ordinary editing.
  for (const [label, bytes] of TAINTING_KEYS) {
    test(`${label} on a plain line is forwarded and the line still submits`, async () => {
      await withHumanTui(async ({ fixture, input, runtime }) => {
        input.write("hello");
        await waitFor(() => runtime.state.phase === "human_editing");
        input.write(bytes);
        await Bun.sleep(120);
        // Forwarded, not withheld: the edit really happens in Grok's editor.
        expect(fixture.writes.join("")).toBe(`hello${bytes}`);
        expect(fixture.warnings).toEqual([]);

        input.write("\r");
        await waitFor(() => fixture.humanPrompts.length > 0);

        expect(fixture.writes.join("")).toBe(`hello${bytes}\r`);
        expect(fixture.warnings).toEqual([]);
      });
    });
  }

  // SECURITY. Once a slash is anywhere in the composer, arrow keys are refused:
  // history recall / cursor motion would make the audited text diverge from
  // what Grok actually holds, so a hidden `/auto` could be submitted. The
  // composer is cancelled outright rather than tainted.
  test("an arrow key after any slash cancels the composer instead of moving the cursor", async () => {
    await withHumanTui(async ({ fixture, input }) => {
      input.write("/");
      await Bun.sleep(40);
      input.write("\x1b[A");
      await waitFor(() => fixture.warnings.some((line) => line.includes("composer history navigation")));

      // "/" reached the TUI, but the history recall key did not.
      expect(fixture.writes.join("")).toBe("/");
      expect(fixture.writes.join("")).not.toContain("\x1b[A");
      expect(fixture.warnings).toEqual([
        `[grok-copresence] composer history navigation ${BLOCK_SUFFIX}`,
      ]);
    });
  });

  // SECURITY. Ctrl+O and Shift+Tab are grok 0.2.93's direct always-approve
  // toggles - no palette, no Enter. They are swallowed before the PTY, so the
  // human never even sees the mode flip attempt. These two must never be
  // forwarded, whatever happens to the slash palette.
  test("Ctrl+O and Shift+Tab are swallowed and never reach the TUI", async () => {
    await withHumanTui(async ({ fixture, input }) => {
      input.write("\x0f");
      await waitFor(() => fixture.warnings.some((line) => line.includes("Ctrl+O")));
      input.write("\x1b[Z");
      await waitFor(() => fixture.warnings.some((line) => line.includes("Shift+Tab")));

      expect(fixture.warnings).toEqual([
        `[grok-copresence] Ctrl+O ${BLOCK_SUFFIX}`,
        `[grok-copresence] Shift+Tab ${BLOCK_SUFFIX}`,
      ]);
      // Not a single byte of either toggle was written to the shared PTY.
      expect(fixture.writes.join("")).toBe("");
    });
  });

  // ISSUE #880. The interception is also an arbitration release path: the
  // Ctrl-C cancel fires `human_input_cancelled`, which returns the state
  // machine to idle and calls scheduleNetworkIfIdle(). A network task that was
  // queued behind the human's editing session is therefore injected BY the
  // block. Snapshot of the coupling as it stands on 2026-08-15 - recording it,
  // not endorsing it. Whoever fixes #880 will turn this test red on purpose.
  test("a blocked slash submit releases the queued network turn (issue #880)", async () => {
    await withHumanTui(async ({ fixture, input, runtime }) => {
      // Human takes the turn by typing; the composer is not submitted yet.
      input.write("/plugins");
      await waitFor(() => runtime.state.phase === "human_editing");

      // A network task arrives while the human holds the turn: it must wait.
      const queued = runtime.submit({
        taskId: "queued-behind-human",
        from: "通信龙",
        text: "network work",
        timeoutMs: 5_000,
      });
      await Bun.sleep(150);
      expect(runtime.state.phase).toBe("human_editing");
      expect(fixture.writes.join("")).not.toContain("[Agent Network/");

      // Enter is refused as a slash command - and that refusal is what lets the
      // network task through.
      input.write("\r");
      await waitFor(() => fixture.warnings.some((line) => line.includes("slash command")));
      await waitFor(() => fixture.writes.join("").includes("[Agent Network/"));

      const result = await queued;
      expect(result.replyText).toBe("FINAL queued-behind-human");
      // The human's own text was never submitted; only the network task ran.
      expect(fixture.humanPrompts).toEqual([]);
      const written = fixture.writes.join("");
      expect(written.indexOf("\x03")).toBeLessThan(written.indexOf("[Agent Network/"));
    });
  });
});
