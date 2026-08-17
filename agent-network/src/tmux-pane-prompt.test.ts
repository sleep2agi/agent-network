import { expect, test } from "bun:test";
import { classifyPanePrompt, extractStartFailureReason } from "./tmux-pane-prompt";

// Captured from a real `tmux capture-pane -p` while Claude Code 2.1.147 was
// waiting on the folder-trust prompt in a workspace it had not seen before —
// the exact state that stalled TM智空负责人 on 2026-08-17.
const FOLDER_TRUST_PANE = `
╭──────────────────────────────────────────────╮
│ Do you trust the files in this folder?       │
│                                              │
│ /home/vansin/ai-insight                      │
│                                              │
│ ❯ 1. Yes, I trust this folder                │
│   2. No, exit                                │
╰──────────────────────────────────────────────╯
`;

const DEV_CHANNELS_PANE = `
 WARNING: Loading development channels from server:commhub
 I am using this for local development and I trust its author

 Press Enter to confirm
`;

const NORMAL_CLAUDE_PANE = `
← commhub · 通信龙: [重启后探针] 请只回一行
● Calling commhub… (ctrl+o to expand)
❯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

test("folder-trust prompt is recognised as its own prompt, not as dev-channels", () => {
  expect(classifyPanePrompt(FOLDER_TRUST_PANE)).toBe("folder-trust");
});

test("dev-channels prompt is still recognised", () => {
  expect(classifyPanePrompt(DEV_CHANNELS_PANE)).toBe("dev-channels");
});

test("a normal Claude Code pane matches no prompt, so no Enter is ever sent", () => {
  expect(classifyPanePrompt(NORMAL_CLAUDE_PANE)).toBeNull();
});

test("an empty / still-booting pane matches no prompt", () => {
  expect(classifyPanePrompt("")).toBeNull();
  expect(classifyPanePrompt("\n\n  \n")).toBeNull();
});

// The prompts are sequential, so a capture holding both means trust is already
// answered and its text is merely still on screen. Reporting "folder-trust"
// there would make a watcher that already answered trust sit out the rest of
// its window and never confirm dev-channels — the original hang, reintroduced.
test("when both prompts are in one capture the later one wins, not the leftover", () => {
  expect(classifyPanePrompt(FOLDER_TRUST_PANE + DEV_CHANNELS_PANE)).toBe("dev-channels");
});

// The refusal that actually happened: 5 grok co-presence nodes on a published
// anet whose whitelist has no grok-build-cli.
const REFUSAL_PANE = `
[anet] Refusing to start node "指挥狗": unsupported runtime "grok-build-cli"; expected one of: claude-agent-sdk, claude-code-cli, codex-sdk, codex-app-server, grok-build-acp, opencode-cli
`;

test("the refusal line is pulled out of a dead pane, with the [anet] prefix stripped", () => {
  const reason = extractStartFailureReason(REFUSAL_PANE);
  expect(reason).toContain('unsupported runtime "grok-build-cli"');
  expect(reason).toContain("Refusing to start node");
  expect(reason?.startsWith("[anet]")).toBe(false);
});

// The noise below the refusal is the part that matters: tmux keeps printing
// after the inner command dies, so "just take the last line" would report a
// shell prompt or an npm notice as the reason the node failed.
test("the refusal is picked over unrelated scrollback both above and below it", () => {
  const pane = [
    "warning: something noisy happened earlier",
    "npm notice a new version is available",
    REFUSAL_PANE.trim(),
    "",
    "npm notice Run npm install -g npm@11.0.0 to update",
    "vansin@toodadev3:~$ ",
  ].join("\n");
  expect(extractStartFailureReason(pane)).toContain("unsupported runtime");
});

test("an ❌ line is reported without its prefix decorations", () => {
  const reason = extractStartFailureReason(`[anet] ❌ --accept-dev-channels requires tmux (used for PTY).`);
  expect(reason).toBe("--accept-dev-channels requires tmux (used for PTY).");
});

test("a crash with no anet refusal falls back to the last non-empty line", () => {
  const pane = "booting…\nnode:internal/modules: Cannot find module '@inquirer/prompts'\n\n";
  expect(extractStartFailureReason(pane)).toBe(
    "node:internal/modules: Cannot find module '@inquirer/prompts'",
  );
});

test("an empty pane yields no reason, so the caller cannot print an invented one", () => {
  expect(extractStartFailureReason("")).toBeNull();
  expect(extractStartFailureReason("   \n\n ")).toBeNull();
});
