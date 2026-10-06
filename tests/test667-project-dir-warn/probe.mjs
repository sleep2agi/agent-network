import { projectDirMismatchWarning, statusTaskForReport } from "/src/project-dir-mismatch.ts";

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
  if (statusTaskForReport("idle", "正在做事", hint) !== "正在做事") fail("idle real task was replaced");
  if (statusTaskForReport("working", undefined, hint) !== undefined) fail("working status gained the hint");
  if (statusTaskForReport("offline", undefined, hint) !== undefined) fail("offline status gained the hint");
  if (statusTaskForReport("idle", undefined, null) !== undefined) fail("missing hint invented a task");
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
