import { projectDirMismatchWarning, statusTaskForReport } from "/src/project-dir-mismatch.ts";
import {
  appserverShellCommand,
  bridgeShellCommand,
  externalAppserverBridgeCwd,
  planExternalAppserverNode,
  tuiShellCommand,
} from "/anet/codex-external-appserver.ts";

const ROOT = "/work";
const NODE = "/work/.anet/nodes/demo-node";
const CONFIG = `${NODE}/config.json`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assertFold(hint) {
  if (statusTaskForReport("idle", undefined, hint) !== hint) fail("idle empty task dropped the hint");
  if (statusTaskForReport("idle", "", hint) !== hint) fail("idle blank task dropped the hint");
  if (statusTaskForReport("idle", undefined, hint, 0) !== hint) fail("idle with nothing running dropped the hint");
  if (statusTaskForReport("idle", "", hint, 0) !== hint) fail("idle blank task with nothing running dropped the hint");
  if (statusTaskForReport("idle", undefined, hint, 1) !== undefined) fail("in-flight idle report covered the running task");
  if (statusTaskForReport("idle", "", hint, 2) !== undefined) fail("in-flight blank idle report covered the running task");
  if (statusTaskForReport("idle", "正在做事", hint) !== "正在做事") fail("idle real task was replaced");
  if (statusTaskForReport("idle", "正在做事", hint, 1) !== "正在做事") fail("in-flight caller task was replaced");
  if (statusTaskForReport("working", undefined, hint) !== undefined) fail("working status gained the hint");
  if (statusTaskForReport("working", "正在做事", hint, 1) !== "正在做事") fail("working task was replaced while in flight");
  if (statusTaskForReport("offline", undefined, hint) !== undefined) fail("offline status gained the hint");
  if (statusTaskForReport("offline", undefined, hint, 1) !== undefined) fail("offline in-flight status gained the hint");
  if (statusTaskForReport("idle", undefined, null) !== undefined) fail("missing hint invented a task");
  if (statusTaskForReport("idle", undefined, null, 1) !== undefined) fail("missing hint invented a task while in flight");
}

const mode = process.argv[2];
const started = process.cwd();

if (mode === "root") {
  if (started !== ROOT) fail(`root mode cwd=${started}`);
  const warning = projectDirMismatchWarning({ configPath: CONFIG, cwd: started });
  if (warning) fail(`root start warned: ${warning}`);
  if (process.cwd() !== started) fail("directory changed");
  const viaLink = projectDirMismatchWarning({ configPath: CONFIG, cwd: "/link-work" });
  if (viaLink) fail(`symlink of workspace root warned: ${viaLink}`);
  const slash = projectDirMismatchWarning({ configPath: CONFIG, cwd: `${ROOT}/` });
  if (slash) fail(`trailing slash warned: ${slash}`);
  const foreign = projectDirMismatchWarning({ configPath: "/tmp/demo-node-config.json", cwd: NODE });
  if (foreign) fail(`foreign config warned: ${foreign}`);
  const profiles = projectDirMismatchWarning({
    configPath: `${ROOT}/.anet/profiles/demo-node.json`,
    cwd: NODE,
  });
  if (profiles) fail(`profiles config warned: ${profiles}`);
  const elsewhere = projectDirMismatchWarning({ configPath: CONFIG, cwd: `${ROOT}/elsewhere` });
  if (!elsewhere || !elsewhere.includes(`${ROOT}/elsewhere`) || !elsewhere.includes(`"${ROOT}"`)) {
    fail(`other directory did not warn: ${elsewhere}`);
  }
  // Home-registry supervisor: config is <home>/.anet/nodes/<name>/config.json
  // and the process was started in <home>. That matches. Starting inside the
  // node directory still warns — do not whitelist that layout.
  const home = "/home/demo";
  const daemonConfig = `${home}/.anet/nodes/demo-daemon/config.json`;
  const daemonAtHome = projectDirMismatchWarning({ configPath: daemonConfig, cwd: home });
  if (daemonAtHome) fail(`home-registry supervisor warned: ${daemonAtHome}`);
  const daemonInNodeDir = projectDirMismatchWarning({
    configPath: daemonConfig,
    cwd: `${home}/.anet/nodes/demo-daemon`,
  });
  if (!daemonInNodeDir || !daemonInNodeDir.includes(`"${home}"`)) {
    fail(`node-directory start of a home-registry config stayed quiet: ${daemonInNodeDir}`);
  }
  // Product external bridge: tmux cwd is the workspace. Hand start in the
  // node directory still warns. Codex pins -C and CODEX_HOME itself.
  const planned = planExternalAppserverNode({
    alias: "demo-node",
    nodeDir: NODE,
    workspaceDir: ROOT,
    profile: {
      runtime: "codex-app-server",
      codexAppServerUrl: "ws://127.0.0.1:9",
      codexThreadId: "0199aaaa-bbbb-cccc-dddd-eeeeffff0001",
      codexProjectDir: `${ROOT}/project`,
      codexCopresence: true,
    },
  });
  if (!planned.ok) fail(planned.error);
  const bridgeCwd = externalAppserverBridgeCwd(planned.plan);
  const productWarning = projectDirMismatchWarning({ configPath: CONFIG, cwd: bridgeCwd });
  if (productWarning) fail(`product external bridge warned: ${productWarning}`);
  const hand = projectDirMismatchWarning({ configPath: CONFIG, cwd: NODE });
  if (!hand) fail("hand start in the node directory stayed quiet");
  const bridgeCmd = bridgeShellCommand(planned.plan, { command: "bun", argsPrefix: ["cli.js"] });
  if (!bridgeCmd.includes(`'--config' '${CONFIG}'`)) fail(`bridge config is not absolute: ${bridgeCmd}`);
  if (!bridgeCmd.includes(`'--log-dir' '${NODE}/logs'`)) fail(`bridge log-dir is not absolute: ${bridgeCmd}`);
  const appCmd = appserverShellCommand(planned.plan, "bun");
  if (!appCmd.includes(`-C '${ROOT}/project'`)) fail(`app-server does not pin -C: ${appCmd}`);
  if (!appCmd.includes(`CODEX_HOME='${NODE}/codex-home'`)) fail(`app-server does not pin CODEX_HOME: ${appCmd}`);
  const tuiCmd = tuiShellCommand(planned.plan);
  if (!tuiCmd.includes(`-C '${ROOT}/project'`)) fail(`tui does not pin -C: ${tuiCmd}`);
  assertFold("hint-for-fold");
  console.log(`project_dir=${started}`);
  console.log("warning=");
  console.log("ROOT_OK");
  process.exit(0);
}

if (mode === "node") {
  if (started !== NODE) fail(`node mode cwd=${started}`);
  const warning = projectDirMismatchWarning({ configPath: CONFIG, cwd: started });
  if (process.cwd() !== started) fail("directory changed");
  const reported = process.cwd();
  if (reported !== NODE) fail(`project_dir rewritten to ${reported}`);
  if (!warning) {
    console.log("FAIL: node-dir start produced no warning");
    process.exit(1);
  }
  for (const piece of [NODE, `"${ROOT}"`, "anet node start", "cd 到工作区根"]) {
    if (!warning.includes(piece)) fail(`warning missing ${piece}: ${warning}`);
  }
  if (statusTaskForReport("idle", undefined, warning) !== warning) fail("hub idle task is not the warning");
  if (statusTaskForReport("working", "正在做事", warning) !== "正在做事") fail("working task was replaced");
  console.log(`project_dir=${reported}`);
  console.log(`warning=${warning}`);
  console.log("NODE_OK");
  process.exit(0);
}

fail(`unknown mode ${mode}`);
