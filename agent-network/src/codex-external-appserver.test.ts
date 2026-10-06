import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  EXTERNAL_APPSERVER_LAYOUT,
  appserverShellCommand,
  bridgeShellCommand,
  exactSessionRows,
  externalAppserverRequested,
  externalAppserverSessions,
  externalAppserverStopOrder,
  externalAppserverBridgeCwd,
  planExternalAppserverNode,
  portBusy,
  resumedThreadVerdict,
  sessionsAlreadyPresent,
  tuiShellCommand,
} from "./codex-external-appserver";

const THREAD = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
const base = {
  runtime: "codex-app-server",
  codexAppServerUrl: "ws://127.0.0.1:47101",
  codexThreadId: THREAD,
  codexProjectDir: "/work/demo/project",
  codexCopresence: true,
  model: "gpt-demo",
};
function plan(over: Record<string, unknown> = {}) {
  const r = planExternalAppserverNode({ alias: "示例节点", nodeDir: "/work/demo/.anet/nodes/示例节点", workspaceDir: "/work/demo", profile: { ...base, ...over } as any });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

describe("#630 lane selection", () => {
  test("opt-in by flag or recorded layout only", () => {
    expect(externalAppserverRequested(false, base, "codex-app-server")).toBe(false);
    expect(externalAppserverRequested(true, base, "codex-app-server")).toBe(true);
    expect(externalAppserverRequested(false, { ...base, codexLaunchLayout: EXTERNAL_APPSERVER_LAYOUT }, "codex-app-server")).toBe(true);
  });
  test("needs codex-app-server and a URL", () => {
    expect(externalAppserverRequested(true, base, "claude-code")).toBe(false);
    expect(externalAppserverRequested(true, { ...base, codexAppServerUrl: "" }, "codex-app-server")).toBe(false);
  });
});

describe("#630 sessions", () => {
  test("names and stop order (bridge first)", () => {
    expect(externalAppserverSessions("示例节点")).toEqual({ appsrv: "示例节点-appsrv", tui: "示例节点-tui", bridge: "示例节点" });
    expect(externalAppserverStopOrder("demo-node")).toEqual(["demo-node", "demo-node-tui", "demo-node-appsrv"]);
  });
  test("exact match, never prefix", () => {
    const existing = ["示例节点2", "示例节点2-appsrv", "示例节点-appsrv-old"];
    expect(sessionsAlreadyPresent(existing, ["示例节点-appsrv", "示例节点-tui", "示例节点"])).toEqual([]);
    expect(sessionsAlreadyPresent([...existing, "示例节点-tui"], ["示例节点-appsrv", "示例节点-tui", "示例节点"])).toEqual(["示例节点-tui"]);
    const rows = [{ id: "$1", name: "示例节点2" }, { id: "$2", name: "示例节点" }, { id: "$3", name: "示例节点-appsrv" }];
    expect(exactSessionRows(rows, externalAppserverStopOrder("示例节点")).map((r) => r.id)).toEqual(["$2", "$3"]);
  });
});

describe("#630 plan", () => {
  test("empty codexProjectDir falls back to the workspace", () => {
    const p = plan({ codexProjectDir: "" });
    expect(p.projectDir).toBe("/work/demo");
    expect(p.projectDirFromWorkspace).toBe(true);
    expect(appserverShellCommand(p, "/usr/bin/node")).toContain("-C '/work/demo' app-server");
    expect(appserverShellCommand(p, "/usr/bin/node")).not.toContain("-C ''");
  });
  test("CODEX_HOME: env, then codexHome, then <nodeDir>/codex-home", () => {
    expect(plan().codexHome).toBe("/work/demo/.anet/nodes/示例节点/codex-home");
    expect(plan({ codexHome: "/h2" }).codexHome).toBe("/h2");
    expect(plan({ codexHome: "/h2", env: { CODEX_HOME: "/h1" } }).codexHome).toBe("/h1");
    expect(plan({ env: { CODEX_HOME: { envRef: "X" } } }).codexHome).toBe("/work/demo/.anet/nodes/示例节点/codex-home");
  });
  test("TUI only with codexCopresence and a thread", () => {
    expect(plan().tui).toBe(true);
    expect(plan({ codexCopresence: false }).tui).toBe(false);
    expect(plan({ codexThreadId: "" }).tui).toBe(false);
  });
  test("URL must be loopback with a port", () => {
    const bad = (url: string) => planExternalAppserverNode({ alias: "a", nodeDir: "/n", workspaceDir: "/w", profile: { ...base, codexAppServerUrl: url } });
    expect(bad("ws://10.0.0.5:47101").ok).toBe(false);
    expect(bad("ws://127.0.0.1").ok).toBe(false);
    expect(bad("not a url").ok).toBe(false);
    expect(plan().readyzUrl).toBe("http://127.0.0.1:47101/readyz");
  });
});

describe("#630 commands", () => {
  const p = plan();
  test("token is read inside the session, never interpolated", () => {
    const cmd = appserverShellCommand(p, "/usr/bin/node");
    expect(cmd).toContain("ANET_EXTAPP_CONFIG='/work/demo/.anet/nodes/示例节点/config.json'");
    expect(cmd).toContain("export ANET_CODEX_COMMHUB_TOKEN");
    expect(cmd).toContain(".env");
    expect(cmd).toContain("export CODEX_HOME='/work/demo/.anet/nodes/示例节点/codex-home'");
  });
  test("TUI resumes the configured thread on the remote URL", () => {
    expect(tuiShellCommand(p)).toContain(`resume '${THREAD}' --remote 'ws://127.0.0.1:47101' -m 'gpt-demo' --no-alt-screen`);
  });
  test("bridge argv", () => {
    const cmd = bridgeShellCommand(p, { command: "/usr/bin/node", argsPrefix: ["/pkg/dist/cli.js"] });
    expect(cmd).toContain("'/usr/bin/node' '/pkg/dist/cli.js' '--config' '/work/demo/.anet/nodes/示例节点/config.json' '--alias' '示例节点' '--runtime' 'codex-app-server' '--model' 'gpt-demo' '--log-dir'");
  });
  test("product bridge cwd is the workspace, not the node directory", () => {
    const p = plan();
    expect(externalAppserverBridgeCwd(p)).toBe("/work/demo");
    expect(externalAppserverBridgeCwd(p)).not.toBe(p.nodeDir);
    const cmd = bridgeShellCommand(p, { command: "/usr/bin/node", argsPrefix: ["/pkg/dist/cli.js"] });
    expect(cmd).toContain("'--config' '/work/demo/.anet/nodes/示例节点/config.json'");
    expect(cmd).toContain("'--log-dir' '/work/demo/.anet/nodes/示例节点/logs'");
    expect(appserverShellCommand(p, "/usr/bin/node")).toContain("-C '/work/demo/project'");
    expect(appserverShellCommand(p, "/usr/bin/node")).toContain("export CODEX_HOME='/work/demo/.anet/nodes/示例节点/codex-home'");
    expect(tuiShellCommand(p)).toContain("-C '/work/demo/project'");
    const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8");
    expect(cli.split("externalAppserverBridgeCwd(plan)").length - 1).toBe(1);
    expect(cli.split('"-c", plan.nodeDir').length - 1).toBe(2);
  });
});

describe("#630 memory", () => {
  test("the 4 GiB hard reject is not this module's job", () => {
    const src = readFileSync(new URL("./codex-external-appserver.ts", import.meta.url), "utf8");
    expect(src).not.toContain("export function memoryVerdict");
    expect(src).not.toContain("MIN_MEM_AVAILABLE_BYTES");
    expect(src).not.toContain("parseMemAvailableBytes");
    expect(src).not.toContain("MemAvailable < 4");
  });
});

describe("#630 resumed-thread verdict", () => {
  test("match / mismatch / new / not-seen", () => {
    expect(resumedThreadVerdict(`[x] [codex-app-server] resumed thread ${THREAD.slice(0, 12)}… in 5ms`, THREAD).state).toBe("match");
    expect(resumedThreadVerdict("[codex-app-server] resumed thread 99999999-aaa… in 5ms", THREAD).state).toBe("mismatch");
    expect(resumedThreadVerdict("[codex-app-server] created thread 0123456789ab…", THREAD).state).toBe("new-thread");
    expect(resumedThreadVerdict("已注册到 CommHub", THREAD).state).toBe("not-seen");
    expect(resumedThreadVerdict("", "").state).toBe("no-thread-configured");
    // the last event wins
    expect(resumedThreadVerdict(`resumed thread ${THREAD.slice(0, 12)}…\ncreated thread 0123456789ab…`, THREAD).state).toBe("new-thread");
  });
});

describe("#630 port probe", () => {
  test("busy when something listens", async () => {
    const srv = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as any).port as number;
    expect(await portBusy("127.0.0.1", port)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await portBusy("127.0.0.1", port)).toBe(false);
  });
});
