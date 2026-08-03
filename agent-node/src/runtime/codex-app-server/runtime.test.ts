// RFC-030 — unit tests for the owned codex app-server argv builder and the
// shared-thread terminal-event reconciliation watchdog.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import {
  buildOwnedAppServerArgs,
  COMMHUB_MCP_TOKEN_ENV,
  codexAppServerThink,
  recoverSharedTurnOnAttach,
  type CodexAppServerRuntimeSession,
} from "./runtime";

const URL = "ws://127.0.0.1:24555";

describe("buildOwnedAppServerArgs", () => {
  test("no opts → bare app-server (codex defaults apply)", () => {
    expect(buildOwnedAppServerArgs(URL)).toEqual(["app-server", "--listen", URL]);
  });

  test("approval_policy only → single -c override before --listen", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never" })).toEqual([
      "app-server", "-c", "approval_policy=never", "--listen", URL,
    ]);
  });

  test("sandbox_mode only → single -c override", () => {
    expect(buildOwnedAppServerArgs(URL, { sandboxMode: "workspace-write" })).toEqual([
      "app-server", "-c", "sandbox_mode=workspace-write", "--listen", URL,
    ]);
  });

  test("auto-approve posture (never + danger-full-access) → both overrides, policy first", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never", sandboxMode: "danger-full-access" })).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "--listen", URL,
    ]);
  });

  test("commhubMcpUrl → adds url + bearer-token-env-var -c overrides", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    expect(args).toEqual([
      "app-server",
      "-c", `mcp_servers.commhub.url="http://127.0.0.1:9200"`,
      "-c", `mcp_servers.commhub.bearer_token_env_var="${COMMHUB_MCP_TOKEN_ENV}"`,
      "--listen", URL,
    ]);
  });

  test("the CommHub bearer TOKEN never appears in argv (only the env-var NAME)", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    const joined = args.join(" ");
    expect(joined).toContain("bearer_token_env_var");
    expect(joined).not.toMatch(/ntok_|utok_|Bearer /);
  });

  test("full production posture (yolo + commhub MCP) → stable order, --listen last", () => {
    const args = buildOwnedAppServerArgs(URL, {
      approvalPolicy: "never", sandboxMode: "danger-full-access", commhubMcpUrl: "http://h/mcp-hub",
    });
    expect(args.slice(0, 7)).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "-c", `mcp_servers.commhub.url="http://h/mcp-hub"`,
    ]);
    expect(args[args.length - 2]).toBe("--listen");
    expect(args[args.length - 1]).toBe(URL);
  });
});

describe("recoverSharedTurnOnAttach", () => {
  test("invokes persisted active-turn recovery before shared runtime is returned", async () => {
    const logs: string[] = [];
    let calls = 0;
    await recoverSharedTurnOnAttach({
      async recoverSharedActiveTurn() {
        calls++;
        return { turnId: "human-reconnect", steerable: true };
      },
    }, (line) => logs.push(line), (line) => logs.push(`WARN:${line}`));
    expect(calls).toBe(1);
    expect(logs.some((line) => line.includes("human-reconnect") && line.includes("human/steerable"))).toBe(true);
  });

  test("history read failure is visible and never reported as steerable", async () => {
    const warnings: string[] = [];
    await recoverSharedTurnOnAttach({
      async recoverSharedActiveTurn(): Promise<{ turnId: string | null; steerable: boolean }> {
        throw new Error("history unavailable");
      },
    }, () => { throw new Error("must not log recovery"); }, (line) => warnings.push(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("history unavailable");
  });
});

class ReconcileOnlyBridge extends EventEmitter {
  taskId = "";
  reconcileCalls = 0;
  submitted: Record<string, unknown> | null = null;

  async submitTask(input: { taskId: string; steerIfExternalTurn?: boolean }): Promise<{ started: true; turnId: string }> {
    this.taskId = input.taskId;
    this.submitted = input;
    return { started: true, turnId: "turn_missing_notification" };
  }

  async reconcileActiveTurn(): Promise<{
    recovered: boolean;
    turnId: string;
    status: string;
  }> {
    this.reconcileCalls++;
    this.emit("task_reply", { taskId: this.taskId, text: "recovered-by-watchdog" });
    return {
      recovered: true,
      turnId: "turn_missing_notification",
      status: "completed",
    };
  }
}

describe("codexAppServerThink — terminal-event reconciliation watchdog", () => {
  test("resolves from authoritative reconciliation when turn/completed is missed", async () => {
    const bridge = new ReconcileOnlyBridge();
    const logs: string[] = [];
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;

    const result = await codexAppServerThink(session, {
      taskId: "task_watchdog",
      text: "message delivered by Agent Network",
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
      log: (line) => logs.push(line),
    });

    expect(result).toEqual({
      replyText: "recovered-by-watchdog",
      failed: false,
      queued: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.reconcileCalls).toBe(1);
    expect(logs.some((line) => line.includes("recovered missed terminal event"))).toBe(true);
  });

  test("forwards the authenticated Dashboard steering decision to the bridge", async () => {
    const bridge = new ReconcileOnlyBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    await codexAppServerThink(session, {
      taskId: "task_dashboard",
      text: "follow-up",
      from: "admin",
      steerIfExternalTurn: true,
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
    });
    expect(bridge.submitted).toMatchObject({
      taskId: "task_dashboard",
      text: "follow-up",
      from: "admin",
      steerIfExternalTurn: true,
    });
  });
});
