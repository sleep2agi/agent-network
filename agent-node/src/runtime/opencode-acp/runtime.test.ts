import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { tmpdir } from "os";
import type { OpencodeAcpClient } from "./client";
import { openOpencodeRuntime, opencodeThink } from "./runtime";

function makeLaunchBase(label: string): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode launch isolation tests require Linux uid semantics");
  }
  const userRuntime = `/run/user/${process.getuid()}`;
  mkdirSync(userRuntime, { recursive: true, mode: 0o700 });
  const launchBase = mkdtempSync(join(userRuntime, `.anet-${label}-`));
  expect(statSync(launchBase).mode & 0o777).toBe(0o700);
  return launchBase;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function onlyLaunchRoot(launchBase: string): string {
  const entries = readdirSync(launchBase).filter((name) =>
    name.startsWith(".anet-opencode-launch-"),
  );
  expect(entries).toHaveLength(1);
  return join(launchBase, entries[0]);
}

function runtimeLaunchArtifacts(launchBase: string): string[] {
  return readdirSync(launchBase).filter((name) => !name.startsWith(".opencode-ai-fixture-"));
}

function makePackageBinary(launchBase: string, script: string): string {
  const fixtureRoot = mkdtempSync(join(launchBase, ".opencode-ai-fixture-"));
  const nodeModules = join(fixtureRoot, "node_modules");
  const packageRoot = join(nodeModules, "opencode-ai");
  const binDir = join(packageRoot, "bin");
  const binary = join(binDir, "opencode.exe");
  mkdirSync(nodeModules, { mode: 0o700 });
  mkdirSync(packageRoot, { mode: 0o700 });
  mkdirSync(binDir, { mode: 0o700 });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "opencode-ai",
    version: "1.18.1",
    bin: { opencode: "./bin/opencode.exe" },
  }), { mode: 0o600 });
  writeFileSync(binary, script, { mode: 0o700 });
  return binary;
}

function makeStubBinary(launchBase: string, script: string): string {
  return makePackageBinary(launchBase, `#!/usr/bin/env bun
if (process.argv.includes("--version")) {
  console.log("1.18.1");
  process.exit(0);
}
${script}`);
}

function happyStub(capturePath: string): string {
  return `
    import { writeFileSync } from "fs";
    let buf = "";
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      while (buf.includes("\\n")) {
        const idx = buf.indexOf("\\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
        } else if (req.method === "session/new" || req.method === "session/load") {
          writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
            sessionMethod: req.method,
            processCwd: process.cwd(),
            pwd: process.env.PWD,
            sessionCwd: req.params.cwd,
            policy: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
            latePermission: JSON.parse(process.env.OPENCODE_PERMISSION),
            discovery: {
              projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
              pure: process.env.OPENCODE_PURE,
              externalSkills: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
              claudeCode: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
              lspDownload: process.env.OPENCODE_DISABLE_LSP_DOWNLOAD,
              managedConfig: process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR,
            },
            roots: {
              home: process.env.HOME,
              config: process.env.XDG_CONFIG_HOME,
              data: process.env.XDG_DATA_HOME,
              cache: process.env.XDG_CACHE_HOME,
              state: process.env.XDG_STATE_HOME,
              runtime: process.env.XDG_RUNTIME_DIR,
              tmp: process.env.TMPDIR,
            },
          }));
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { sessionId: req.params.sessionId || "ses_test" },
          }) + "\\n");
        }
      }
    });
  `;
}

describe("openOpencodeRuntime — cwd and tool policy", () => {
  test("safe default keeps spawn + ACP session in one external launch workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-safe-"));
    const launchBase = makeLaunchBase("runtime-safe");
    const workDir = join(root, "node");
    const projectDir = join(root, "project");
    const capture = join(root, "capture.json");
    const binary = makeStubBinary(launchBase, happyStub(capture));
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      session = await openOpencodeRuntime({ cwd: projectDir, workDir, binary, launchBase });
      const seen = JSON.parse(readFileSync(capture, "utf8"));
      const launchRoot = resolve(seen.roots.data, "..");
      const safeWorkspace = join(launchRoot, "workspace");
      expect(seen.processCwd).toBe(safeWorkspace);
      expect(seen.pwd).toBe(safeWorkspace);
      expect(seen.sessionCwd).toBe(safeWorkspace);
      expect(seen.sessionMethod).toBe("session/new");
      expect(launchRoot.startsWith(join(resolve(launchBase), ".anet-opencode-launch-"))).toBe(true);
      expect(pathIsWithin(workDir, launchRoot)).toBe(false);
      expect(pathIsWithin(projectDir, launchRoot)).toBe(false);
      expect(pathIsWithin(workDir, safeWorkspace)).toBe(false);
      expect(pathIsWithin(projectDir, safeWorkspace)).toBe(false);
      expect(statSync(launchRoot).mode & 0o777).toBe(0o700);
      expect(statSync(safeWorkspace).mode & 0o777).toBe(0o700);
      expect(seen.policy.tools.bash).toBe(false);
      expect(seen.policy.tools.read).toBe(false);
      expect(seen.policy.tools.skill).toBe(false);
      expect(seen.policy.tools.question).toBe(false);
      expect(seen.policy.tools.webfetch).toBe(false);
      expect(seen.policy.tools.websearch).toBe(false);
      expect(seen.policy.permission.question).toBe("deny");
      expect(seen.policy.permission.doom_loop).toBe("deny");
      expect(seen.policy.permission["*"]).toBe("deny");
      expect(seen.latePermission).toEqual(seen.policy.permission);
      expect(seen.policy.plugin).toEqual([]);
      expect(seen.discovery).toEqual({
        projectConfig: "true",
        pure: "1",
        externalSkills: "1",
        claudeCode: "1",
        lspDownload: "1",
        managedConfig: join(launchRoot, "managed-config"),
      });
      expect(seen.roots.home).toBe(join(launchRoot, "home"));
      expect(seen.roots.config).toBe(join(launchRoot, "config"));
      expect(seen.roots.cache).toBe(join(launchRoot, "cache"));
      expect(seen.roots.state).toBe(join(launchRoot, "state"));
      expect(seen.roots.runtime).toBe(join(launchRoot, "runtime"));
      expect(seen.roots.tmp).toBe(join(launchRoot, "tmp"));
    } finally {
      await session?.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("version probe root is credential-free and gone before runtime auth is materialized", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-probe-auth-"));
    const launchBase = makeLaunchBase("runtime-probe-auth");
    const workDir = join(root, "node");
    const authDir = join(workDir, ".local", "share", "opencode");
    const probeCapture = join(root, "probe.json");
    const runtimeCapture = join(root, "runtime.json");
    const binary = makePackageBinary(launchBase, `#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
const authPath = join(process.env.XDG_DATA_HOME || "", "opencode", "auth.json");
if (process.argv.includes("--version")) {
  const launchRoot = dirname(process.env.XDG_DATA_HOME || "");
  const marker = JSON.parse(readFileSync(join(launchRoot, ".anet-opencode-launch-owner.json"), "utf8"));
  writeFileSync(${JSON.stringify(probeCapture)}, JSON.stringify({
    authExists: existsSync(authPath),
    launchRoot,
    markerWorkDir: marker.workDir,
    launchEntries: readdirSync(${JSON.stringify(launchBase)}).filter((name) => name.startsWith(".anet-opencode-launch-")),
  }));
  console.log("1.18.1");
  process.exit(0);
}
writeFileSync(${JSON.stringify(runtimeCapture)}, JSON.stringify({
  auth: JSON.parse(readFileSync(authPath, "utf8")),
  launchRoot: dirname(process.env.XDG_DATA_HOME || ""),
}));
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (buf.includes("\\n")) {
    const idx = buf.indexOf("\\n");
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
    } else if (req.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId: "ses_probe_auth" } }) + "\\n");
    }
  }
});
`);
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(authDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({
        anthropic: { type: "api", key: "synthetic-probe-secret" },
      }), { mode: 0o600 });
      session = await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });

      const probe = JSON.parse(readFileSync(probeCapture, "utf8"));
      const runtime = JSON.parse(readFileSync(runtimeCapture, "utf8"));
      expect(probe.authExists).toBe(false);
      expect(probe.markerWorkDir).toBe(probe.launchRoot);
      expect(probe.launchEntries).toHaveLength(1);
      expect(existsSync(probe.launchRoot)).toBe(false);
      expect(runtime.launchRoot).not.toBe(probe.launchRoot);
      expect(runtime.auth.anthropic.key).toBe("synthetic-probe-secret");
    } finally {
      await session?.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("safe session/load reuses the exact spawn PWD as its ACP cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-safe-load-"));
    const launchBase = makeLaunchBase("runtime-safe-load");
    const workDir = join(root, "node");
    const projectDir = join(root, "project");
    const capture = join(root, "capture.json");
    const binary = makeStubBinary(launchBase, happyStub(capture));
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      session = await openOpencodeRuntime({
        cwd: projectDir,
        workDir,
        binary,
        launchBase,
        sessionId: "ses_existing",
      });
      const seen = JSON.parse(readFileSync(capture, "utf8"));
      const launchRoot = resolve(seen.roots.data, "..");
      const workspace = join(launchRoot, "workspace");
      expect(seen.sessionMethod).toBe("session/load");
      expect(seen.processCwd).toBe(workspace);
      expect(seen.pwd).toBe(workspace);
      expect(seen.sessionCwd).toBe(workspace);
      expect(session.sessionId).toBe("ses_existing");
      expect(launchRoot.startsWith(join(resolve(launchBase), ".anet-opencode-launch-"))).toBe(true);
      expect(pathIsWithin(workDir, workspace)).toBe(false);
      expect(pathIsWithin(projectDir, workspace)).toBe(false);

      await session.client.stop("SIGTERM");
      expect(existsSync(launchRoot)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
      session = null;
    } finally {
      if (session?.client.isRunning) await session.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit unsafe flag restores project cwd and emits a trusted-task warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-unsafe-"));
    const launchBase = makeLaunchBase("runtime-unsafe");
    const workDir = join(root, "node");
    const projectDir = join(root, "project");
    const capture = join(root, "capture.json");
    // spawn cwd must exist before open().
    mkdirSync(projectDir, { recursive: true });
    const binary = makeStubBinary(launchBase, happyStub(capture));
    const warnings: string[] = [];
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      session = await openOpencodeRuntime({
        cwd: projectDir,
        workDir,
        unsafeTools: true,
        binary,
        launchBase,
        warn: (message) => warnings.push(message),
      });
      const seen = JSON.parse(readFileSync(capture, "utf8"));
      expect(seen.processCwd).toBe(resolve(projectDir));
      expect(seen.sessionCwd).toBe(resolve(projectDir));
      expect(seen.pwd).toBe(resolve(projectDir));
      expect(seen.policy.tools.bash).toBe(true);
      expect(seen.policy.tools.read).toBe(true);
      expect(seen.policy.tools.skill).toBe(true);
      expect(seen.policy.tools.question).toBe(false);
      expect(seen.policy.permission.question).toBe("deny");
      expect(seen.policy.plugin).toBeUndefined();
      expect(seen.discovery).toEqual({});
      const launchRoot = resolve(seen.roots.data, "..");
      expect(launchRoot.startsWith(join(resolve(launchBase), ".anet-opencode-launch-"))).toBe(true);
      expect(pathIsWithin(workDir, launchRoot)).toBe(false);
      expect(existsSync(join(launchRoot, "workspace"))).toBe(false);
      expect(seen.roots.home).toBe(resolve(workDir));
      expect(seen.roots.config).toBe(join(resolve(workDir), ".config"));
      expect(seen.roots.cache).toBe(join(launchRoot, "cache"));
      expect(seen.roots.state).toBe(join(launchRoot, "state"));
      expect(seen.roots.runtime).toBe(join(launchRoot, "runtime"));
      expect(seen.roots.tmp).toBe(join(launchRoot, "tmp"));
      expect(warnings.some((message) => message.includes("UNSAFE local tools"))).toBe(true);
    } finally {
      await session?.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("openOpencodeRuntime — opening lifecycle", () => {
  test("normal stop removes the launch root and copied vendor auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-clean-"));
    const launchBase = makeLaunchBase("runtime-clean");
    const workDir = join(root, "node");
    const capture = join(root, "capture.json");
    const binary = makeStubBinary(launchBase, happyStub(capture));
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(join(workDir, ".local", "share", "opencode"), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(workDir, ".local", "share", "opencode", "auth.json"),
        JSON.stringify({ anthropic: { type: "api", key: "runtime-cleanup-test" } }),
        { mode: 0o600 },
      );
      session = await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      const seen = JSON.parse(readFileSync(capture, "utf8"));
      const launchRoot = resolve(seen.roots.data, "..");
      const workspace = seen.processCwd;
      const copiedAuth = join(seen.roots.data, "opencode", "auth.json");
      expect(existsSync(copiedAuth)).toBe(true);
      expect(workspace).toBe(join(launchRoot, "workspace"));
      expect(existsSync(workspace)).toBe(true);

      await session.client.stop("SIGTERM");
      expect(session.client.isRunning).toBe(false);
      expect(existsSync(copiedAuth)).toBe(false);
      expect(existsSync(launchRoot)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
      session = null;
    } finally {
      if (session?.client.isRunning) await session.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repeated open/stop cycles do not accumulate launch roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-repeat-"));
    const launchBase = makeLaunchBase("runtime-repeat");
    const workDir = join(root, "node");
    const capture = join(root, "capture.json");
    const binary = makeStubBinary(launchBase, happyStub(capture));
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      for (let index = 0; index < 25; index += 1) {
        session = await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
        const seen = JSON.parse(readFileSync(capture, "utf8"));
        const launchRoot = resolve(seen.roots.data, "..");
        const workspace = seen.processCwd;
        expect(workspace).toBe(join(launchRoot, "workspace"));
        expect(existsSync(launchRoot)).toBe(true);
        expect(existsSync(workspace)).toBe(true);
        await session.client.stop("SIGTERM");
        expect(existsSync(launchRoot)).toBe(false);
        expect(existsSync(workspace)).toBe(false);
        expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
        session = null;
      }
    } finally {
      if (session?.client.isRunning) await session.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an ancestor candidate planted by the version probe hard-fails before ACP spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-pre-spawn-"));
    const launchBase = makeLaunchBase("runtime-pre-spawn");
    const workDir = join(root, "node");
    const candidate = join(launchBase, "opencode.json");
    const acpStarted = join(root, "acp-started.txt");
    const binary = makePackageBinary(launchBase, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
if (process.argv.includes("--version")) {
  writeFileSync(${JSON.stringify(candidate)}, "{}", { mode: 0o600 });
  console.log("1.18.1");
  process.exit(0);
}
writeFileSync(${JSON.stringify(acpStarted)}, "spawned", { mode: 0o600 });
process.stdin.resume();
`);
    let thrown: Error | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      try {
        await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      } catch (error: any) {
        thrown = error;
      }
      expect(thrown?.message).toContain("ancestor discovery candidate");
      expect(existsSync(acpStarted)).toBe(false);
      // The failed pre-spawn path discards the whole external root/workspace;
      // only the deliberately planted ancestor candidate remains.
      expect(runtimeLaunchArtifacts(launchBase)).toEqual(["opencode.json"]);
    } finally {
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("package replacement after credential-free probe is rejected and runtime auth root is discarded", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-post-probe-swap-"));
    const launchBase = makeLaunchBase("runtime-post-probe-swap");
    const workDir = join(root, "node");
    const acpStarted = join(root, "acp-started.txt");
    const binary = makePackageBinary(launchBase, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
if (process.argv.includes("--version")) {
  const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));
  writeFileSync(packageJson, JSON.stringify({
    name: "opencode-ai",
    version: "1.18.0",
    bin: { opencode: "./bin/opencode.exe" },
  }));
  console.log("1.18.1");
  process.exit(0);
}
writeFileSync(${JSON.stringify(acpStarted)}, "spawned");
process.stdin.resume();
`);
    let thrown: Error | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      try {
        await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      } catch (error: any) {
        thrown = error;
      }
      expect(thrown?.message).toContain("opencode-ai@1.18.1");
      expect(existsSync(acpStarted)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("in-place binary self-modification after probe is rejected before credential spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-post-probe-binary-swap-"));
    const launchBase = makeLaunchBase("runtime-post-probe-binary-swap");
    const workDir = join(root, "node");
    const acpStarted = join(root, "acp-started.txt");
    const binary = makePackageBinary(launchBase, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
if (process.argv.includes("--version")) {
  writeFileSync(fileURLToPath(import.meta.url), "#!/usr/bin/env bun\\nprocess.exit(91);\\n", { mode: 0o700 });
  console.log("1.18.1");
  process.exit(0);
}
writeFileSync(${JSON.stringify(acpStarted)}, "spawned");
process.stdin.resume();
`);
    let thrown: Error | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      try {
        await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      } catch (error: any) {
        thrown = error;
      }
      expect(thrown?.message).toContain("package bytes changed after version probe");
      expect(existsSync(acpStarted)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production rejects canonical same-version packages below project cwd or node workDir", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-package-roots-"));
    const launchBase = makeLaunchBase("runtime-package-roots");
    const projectWorkDir = join(launchBase, "project-case-node");
    const projectDir = join(launchBase, "project-case-project");
    const workDir = join(launchBase, "workdir-case-node");
    const workProjectDir = join(launchBase, "workdir-case-project");
    const projectProbe = join(root, "project-probe-executed");
    const workDirProbe = join(root, "workdir-probe-executed");
    try {
      for (const dir of [projectWorkDir, projectDir, workDir, workProjectDir]) {
        mkdirSync(dir, { mode: 0o700 });
      }
      const projectBinary = makePackageBinary(projectDir, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(projectProbe)}, "executed");
console.log("1.18.1");
`);
      let projectError: Error | undefined;
      try {
        await openOpencodeRuntime({
          cwd: projectDir,
          workDir: projectWorkDir,
          binary: projectBinary,
          launchBase,
        });
      } catch (error: any) {
        projectError = error;
      }
      expect(projectError?.message).toContain("overlaps forbidden root");
      expect(existsSync(projectProbe)).toBe(false);

      const workDirBinary = makePackageBinary(workDir, `#!/usr/bin/env bun
import { writeFileSync } from "fs";
writeFileSync(${JSON.stringify(workDirProbe)}, "executed");
console.log("1.18.1");
`);
      let workDirError: Error | undefined;
      try {
        await openOpencodeRuntime({
          cwd: workProjectDir,
          workDir,
          binary: workDirBinary,
          launchBase,
        });
      } catch (error: any) {
        workDirError = error;
      }
      expect(workDirError?.message).toContain("overlaps forbidden root");
      expect(existsSync(workDirProbe)).toBe(false);
    } finally {
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initialize failure force-kills the child before rejecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-fail-"));
    const launchBase = makeLaunchBase("runtime-fail");
    const workDir = join(root, "node");
    const pidPath = join(root, "child.pid");
    const binary = makeStubBinary(launchBase, `
      import { writeFileSync } from "fs";
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        if (!buf.includes("\\n")) return;
        const req = JSON.parse(buf.slice(0, buf.indexOf("\\n")));
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: req.id,
          error: { code: -32000, message: "handshake rejected" },
        }) + "\\n");
      });
    `);
    let exposed: OpencodeAcpClient | null = null;
    let thrown: Error | null = null;
    let failedLaunchRoot: string | undefined;
    let failedWorkspace: string | undefined;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      try {
        await openOpencodeRuntime({
          cwd: root,
          workDir,
          binary,
          launchBase,
          onClient: (client) => {
            exposed = client;
            failedLaunchRoot = onlyLaunchRoot(launchBase);
            failedWorkspace = join(failedLaunchRoot, "workspace");
            expect(existsSync(failedWorkspace)).toBe(true);
          },
        });
      } catch (error: any) {
        thrown = error;
      }
      expect(thrown?.message).toContain("handshake rejected");
      expect(exposed).not.toBeNull();
      expect(exposed!.isRunning).toBe(false);
      expect(existsSync(pidPath)).toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      let alive = true;
      try { process.kill(pid, 0); }
      catch { alive = false; }
      expect(alive).toBe(false);
      expect(failedLaunchRoot).toBeDefined();
      expect(failedWorkspace).toBeDefined();
      expect(existsSync(failedLaunchRoot!)).toBe(false);
      expect(existsSync(failedWorkspace!)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      if (exposed?.isRunning) await exposed.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onClient exposes a stalled-handshake child synchronously for shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-opening-"));
    const launchBase = makeLaunchBase("runtime-opening");
    const workDir = join(root, "node");
    const binary = makeStubBinary(launchBase, `
      // Consume initialize but deliberately never answer it.
      process.stdin.resume();
    `);
    let exposed: OpencodeAcpClient | null = null;
    let openingLaunchRoot: string | undefined;
    let openingWorkspace: string | undefined;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      const opening = openOpencodeRuntime({
        cwd: root,
        workDir,
        binary,
        launchBase,
        onClient: (client) => {
          exposed = client;
          openingLaunchRoot = onlyLaunchRoot(launchBase);
          openingWorkspace = join(openingLaunchRoot, "workspace");
          expect(existsSync(openingWorkspace)).toBe(true);
        },
      });
      // Async function execution reaches its first request await before this
      // statement, so the handle must already be available without polling.
      expect(exposed).not.toBeNull();
      expect(exposed!.isRunning).toBe(true);
      await exposed!.stop("SIGKILL");
      let thrown: Error | null = null;
      try { await opening; }
      catch (error: any) { thrown = error; }
      expect(thrown?.message).toContain("opencode acp exited");
      expect(exposed!.isRunning).toBe(false);
      expect(existsSync(openingLaunchRoot!)).toBe(false);
      expect(existsSync(openingWorkspace!)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      if (exposed?.isRunning) await exposed.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("opencodeThink — failed-turn lifecycle", () => {
  test("prompt idle timeout force-kills the child before rejecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-idle-"));
    const launchBase = makeLaunchBase("runtime-idle");
    const workDir = join(root, "node");
    const pidPath = join(root, "child.pid");
    const binary = makeStubBinary(launchBase, `
      import { writeFileSync } from "fs";
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
          } else if (req.method === "session/new") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: req.id, result: { sessionId: "ses_idle" },
            }) + "\\n");
          }
          // Deliberately never answer session/prompt. A late answer from this
          // process must never be able to bleed into the next CommHub task.
        }
      });
    `);
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    let thrown: Error | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      session = await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      const launchRoot = onlyLaunchRoot(launchBase);
      const workspace = join(launchRoot, "workspace");
      expect(existsSync(workspace)).toBe(true);
      try {
        await opencodeThink(session, {
          prompt: "hang forever",
          cwd: root,
          workDir,
          idleTimeoutMs: 50,
        });
      } catch (error: any) {
        thrown = error;
      }
      expect(thrown?.message).toContain("idle for");
      expect(session.client.isRunning).toBe(false);
      expect(existsSync(pidPath)).toBe(true);
      const pid = Number(readFileSync(pidPath, "utf8"));
      let alive = true;
      try { process.kill(pid, 0); }
      catch { alive = false; }
      expect(alive).toBe(false);
      expect(existsSync(launchRoot)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      if (session?.client.isRunning) await session.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed thinking-only rescue discards the child before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-runtime-rescue-idle-"));
    const launchBase = makeLaunchBase("runtime-rescue-idle");
    const workDir = join(root, "node");
    const binary = makeStubBinary(launchBase, `
      let buf = "";
      let prompts = 0;
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\\n");
          } else if (req.method === "session/new") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: req.id, result: { sessionId: "ses_rescue_idle" },
            }) + "\\n");
          } else if (req.method === "session/prompt" && ++prompts === 1) {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "ses_rescue_idle",
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: "thinking only" },
                },
              },
            }) + "\\n");
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" },
            }) + "\\n");
          }
          // The second (rescue) prompt deliberately hangs.
        }
      });
    `);
    const warnings: string[] = [];
    let session: Awaited<ReturnType<typeof openOpencodeRuntime>> | null = null;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      session = await openOpencodeRuntime({ cwd: root, workDir, binary, launchBase });
      const launchRoot = onlyLaunchRoot(launchBase);
      const workspace = join(launchRoot, "workspace");
      expect(existsSync(workspace)).toBe(true);
      const outcome = await opencodeThink(session, {
        prompt: "produce thinking only",
        cwd: root,
        workDir,
        idleTimeoutMs: 50,
        warn: (message) => warnings.push(message),
      });
      expect(outcome.replyText).toBe("");
      expect(outcome.thoughtText).toContain("thinking only");
      expect(outcome.rescued).toBe(false);
      expect(session.client.isRunning).toBe(false);
      expect(warnings.some((message) => message.includes("rescue re-prompt failed; child discarded"))).toBe(true);
      expect(existsSync(launchRoot)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(runtimeLaunchArtifacts(launchBase)).toEqual([]);
    } finally {
      if (session?.client.isRunning) await session.client.stop("SIGKILL");
      rmSync(launchBase, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
