// Issue #1379: npx-layout resolution for the feishu worker path.
//
// The old resolver had only four candidates, all derived from `import.meta.url`
// (i.e. the location of agent-node's own dist/cli.js). Under the *most common*
// install pattern — `anet node start` spawns agent-node via `npx`, and the
// operator has @sleep2agi/agent-network installed globally — all four missed:
// npx's cache dir does not contain agent-network (agent-node's package.json
// does not list it as a dependency), and the global-prefix candidates
// (../../../..) do not walk out of the npx cache tree either. Feishu channel
// then failed silently with a single WARN line.
//
// This test locks in the fix by exercising the pure candidate-derivation
// function against a real temp filesystem that mimics the npx layout.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { computeFeishuWorkerCandidates } from "./feishu-worker-resolve";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkdTemp(): string {
  const d = mkdtempSync(join(tmpdir(), "pr1379-feishu-"));
  dirs.push(d);
  return d;
}

/** Simulate `~/.npm/_npx/<hash>/node_modules/@sleep2agi/agent-node/dist/` */
function makeNpxAgentNode(root: string): string {
  const npx = join(root, "npm-cache", "_npx", "abcd1234", "node_modules");
  mkdirSync(join(npx, "@sleep2agi", "agent-node", "dist"), { recursive: true });
  return join(npx, "@sleep2agi", "agent-node", "dist") + "/";
}

/** Place `<prefix>/lib/node_modules/@sleep2agi/agent-network/dist/src/im/feishu/worker.js` */
function placeGlobalWorker(prefix: string): string {
  const workerPath = join(
    prefix, "lib", "node_modules", "@sleep2agi", "agent-network",
    "dist", "src", "im", "feishu", "worker.js",
  );
  mkdirSync(dirname(workerPath), { recursive: true });
  writeFileSync(workerPath, "// fake worker\n", { mode: 0o644 });
  return workerPath;
}

/** Old candidate set — the four candidates that shipped before #1379.
 *  Kept as an in-test transcription so the witnessed-red does not rely
 *  on any old-code fixture in the repo. */
function oldFourCandidates(here: string, envOverride?: string): string[] {
  const c: string[] = [];
  if (envOverride) c.push(envOverride);
  c.push(
    join(here, "..", "..", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    join(here, "..", "..", "agent-network", "src", "im", "feishu", "worker.ts"),
    join(here, "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    join(here, "..", "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
  );
  return c;
}

describe("#1379 resolve feishu worker under npx layout", () => {
  test("witnessed-red: old 4-candidate set does NOT find globally installed worker under npx", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    const globalPrefix = join(root, "usr-local");
    const globalWorker = placeGlobalWorker(globalPrefix);

    // Sanity: the worker really is on disk where we placed it.
    expect(existsSync(globalWorker)).toBe(true);

    // Old logic (the shipping bug): four candidates, none reach global prefix.
    const oldCandidates = oldFourCandidates(here);
    const oldResolved = oldCandidates.find((c) => existsSync(c)) ?? null;
    expect(oldResolved).toBeNull();  // ← the red state — feishu WARN + skip

    // None of the four even names the global prefix by accident.
    for (const c of oldCandidates) {
      expect(c.startsWith(globalPrefix)).toBe(false);
    }
  });

  test("green: new resolver finds the global-prefix worker via npm_config_prefix", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    const globalPrefix = join(root, "usr-local");
    const globalWorker = placeGlobalWorker(globalPrefix);

    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: undefined,
      npmConfigPrefix: globalPrefix,
      nodeExecPath: undefined,
    });
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBe(globalWorker);
  });

  test("green: new resolver finds worker via process.execPath heuristic (POSIX <prefix>/bin/node)", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    const globalPrefix = join(root, "usr-local");
    const globalWorker = placeGlobalWorker(globalPrefix);
    const execPath = join(globalPrefix, "bin", "node");
    // execPath doesn't need to exist as a real binary — resolver just uses dirname()

    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: undefined,
      npmConfigPrefix: undefined,
      nodeExecPath: execPath,
    });
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBe(globalWorker);
  });

  test("green: new resolver finds worker via process.execPath heuristic (Windows-ish <prefix>/node)", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    // Windows layout: `<prefix>/node_modules/...`, no `lib/` interstitial.
    const globalPrefix = join(root, "AppData", "Roaming", "npm");
    const workerPath = join(
      globalPrefix, "node_modules", "@sleep2agi", "agent-network",
      "dist", "src", "im", "feishu", "worker.js",
    );
    mkdirSync(dirname(workerPath), { recursive: true });
    writeFileSync(workerPath, "// fake worker\n", { mode: 0o644 });

    // execPath = <prefix>/node.exe (dirname = <prefix>).
    const execPath = join(globalPrefix, "node.exe");
    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: undefined,
      npmConfigPrefix: undefined,
      nodeExecPath: execPath,
    });
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBe(workerPath);
  });

  test("env override wins over everything", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    // Place two workers: one at explicit override, one at global prefix.
    const explicit = join(root, "my-worker.js");
    writeFileSync(explicit, "// explicit\n", { mode: 0o644 });
    const globalPrefix = join(root, "usr-local");
    placeGlobalWorker(globalPrefix);

    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: explicit,
      npmConfigPrefix: globalPrefix,
      nodeExecPath: join(globalPrefix, "bin", "node"),
    });
    expect(candidates[0]).toBe(explicit);
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBe(explicit);
  });

  test("dev sibling checkout: `agent-node/dist/` next to `agent-network/dist/` still resolves without any global-prefix hint", () => {
    const root = mkdTemp();
    // Repo layout: <root>/agent-node/dist/ + <root>/agent-network/dist/src/im/feishu/worker.js
    const here = join(root, "agent-node", "dist") + "/";
    mkdirSync(here, { recursive: true });
    const devWorker = join(root, "agent-network", "dist", "src", "im", "feishu", "worker.js");
    mkdirSync(dirname(devWorker), { recursive: true });
    writeFileSync(devWorker, "// dev\n", { mode: 0o644 });

    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: undefined,
      npmConfigPrefix: undefined,
      nodeExecPath: undefined,
    });
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBe(devWorker);
  });

  test("nothing on disk anywhere → resolver returns null (skip is still explicit)", () => {
    const root = mkdTemp();
    const here = makeNpxAgentNode(root);
    // No worker anywhere.
    const candidates = computeFeishuWorkerCandidates({
      here,
      envOverride: undefined,
      npmConfigPrefix: join(root, "empty-prefix"),
      nodeExecPath: join(root, "empty-prefix", "bin", "node"),
    });
    const resolved = candidates.find((c) => existsSync(c)) ?? null;
    expect(resolved).toBeNull();
  });
});
