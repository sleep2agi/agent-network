import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/agent-node-src/src/runtime/opencode-copresence/runtime";

const root = mkdtempSync(join(tmpdir(), "anet-test227-"));
chmodSync(root, 0o700);
const project = join(root, "project");
const workDir = join(root, "node");
mkdirSync(project, { recursive: true, mode: 0o700 });
mkdirSync(join(workDir, ".config", "opencode"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(workDir, ".config", "opencode", "opencode.json"),
  JSON.stringify({ model: process.env.OPENCODE_FREE_MODEL || "opencode/north-mini-code-free" }),
  { mode: 0o600 },
);

const tmuxName = "opencode-test227-tui";
let runtime: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
const checks: Record<string, unknown> = {};

function pane(): string {
  return execFileSync("tmux", ["capture-pane", "-p", "-t", tmuxName, "-S", "-200"], { encoding: "utf8" });
}

try {
  runtime = await openOpenCodeCopresenceRuntime({
    cwd: project,
    workDir,
    expectedVersion: process.env.OPENCODE_VERSION_UNDER_TEST || "1.18.1",
    binarySearchPath: process.env.PATH || "",
    startupTimeoutMs: 30_000,
  });
  checks.loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url);
  checks.session = runtime.sessionId;
  checks.launcherMode = statSync(runtime.attachScriptPath).mode & 0o777;
  const launcher = readFileSync(runtime.attachScriptPath, "utf8");
  checks.launcherUsesOfficialAttach = launcher.includes(" attach ") && launcher.includes(runtime.sessionId);
  checks.launcherDoesNotLogPassword = !launcher.includes("set -x");

  execFileSync("tmux", ["new-session", "-d", "-s", tmuxName, "-x", "140", "-y", "45", runtime.attachScriptPath]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  checks.tuiAliveBefore = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;

  const marker = `TUI227_${Date.now().toString(36)}`;
  const first = await runtime.submit(`Reply with exactly ${marker}`, 180_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const firstPane = pane();
  checks.firstReplyLength = first.replyText.length;
  checks.sharedTurnVisibleInTui = firstPane.includes(marker);
  checks.tuiAliveAfterFirst = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;

  const second = await runtime.submit("Reply with exactly SECOND_TURN_OK", 180_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  checks.secondReplyLength = second.replyText.length;
  checks.tuiAliveAfterSecond = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;
  checks.runtimeAliveAfterSecond = runtime.isRunning;

  const failed = [
    checks.loopback === true,
    typeof checks.session === "string" && /^ses_/.test(checks.session),
    checks.launcherMode === 0o700,
    checks.launcherUsesOfficialAttach === true,
    checks.launcherDoesNotLogPassword === true,
    checks.tuiAliveBefore === true,
    Number(checks.firstReplyLength) > 0,
    checks.sharedTurnVisibleInTui === true,
    checks.tuiAliveAfterFirst === true,
    Number(checks.secondReplyLength) > 0,
    checks.tuiAliveAfterSecond === true,
    checks.runtimeAliveAfterSecond === true,
  ].some((ok) => !ok);
  console.log(JSON.stringify({ checks, paneTail: firstPane.slice(-2500) }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", tmuxName]); } catch {}
  await runtime?.close();
  checks.launcherRemoved = runtime ? !existsSync(runtime.attachScriptPath) : false;
  rmSync(root, { recursive: true, force: true });
}
