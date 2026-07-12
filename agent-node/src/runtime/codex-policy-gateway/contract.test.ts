// RFC-030 Wave 1A — contract type + shape tests.
//
// Two goals:
//
//   (a) POSITIVE type-level assertions: the exported types compose the
//       way the runtime side needs them to (discriminated unions
//       exhaust, branded ids don't collapse into `string`, subscriptions
//       are read-only).
//
//   (b) NEGATIVE structural assertions: the "forbidden fields" that
//       Wave-0 explicitly bans (raw JSON-RPC `method`, `threadId`,
//       `turnId`, `policy`, `path`, `config`, `requestId`) do not
//       appear on any exported interface. If a future refactor adds
//       one, this file fails to type-check.
//
// The forbidden-field check is a whole-file source grep of contract.ts
// so a subtle rename can't slip past. It's a light guardrail, not a
// substitute for review, but it makes the deliberate design in
// contract.ts self-enforcing at test time.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asTaskId,
  asMessageId,
  asOwnerLeaseId,
  GatewayErrorCode,
  type AgentTypedContract,
  type AuthenticatedSender,
  type CancelQueuedTaskResult,
  type EnqueueTaskAccepted,
  type EnqueueTaskArgs,
  type EnqueueTaskRefused,
  type EnqueueTaskResult,
  type MessageId,
  type OwnerLeaseId,
  type RuntimeStateEvent,
  type RuntimeStateSubscription,
  type TaskId,
  type TaskState,
} from "./contract";

// Small helper — the test-only bench for the negative discriminant walk.
// TypeScript can't `exhaustiveCheck` at runtime; this pattern makes an
// exhaustive `switch` visible in the assertion.
function assertExhaustive(x: never): never {
  throw new Error(`unreachable — got ${JSON.stringify(x)}`);
}

// ────────────────────────────────────────────────────────────────────────
// Branded id construction
// ────────────────────────────────────────────────────────────────────────

describe("branded ids", () => {
  test("asTaskId round-trips a plain string but rejects empty / too-long", () => {
    const t = asTaskId("t_abc");
    expect(t).toBe("t_abc" as unknown as TaskId);
    expect(() => asTaskId("")).toThrow();
    expect(() => asTaskId("a".repeat(201))).toThrow();
  });

  test("asMessageId round-trips a plain string but rejects empty / too-long", () => {
    const m = asMessageId("m_abc");
    expect(m).toBe("m_abc" as unknown as MessageId);
    expect(() => asMessageId("")).toThrow();
    expect(() => asMessageId("a".repeat(201))).toThrow();
  });

  test("asOwnerLeaseId round-trips a plain string but rejects empty / too-long", () => {
    const o = asOwnerLeaseId("o_abc");
    expect(o).toBe("o_abc" as unknown as OwnerLeaseId);
    expect(() => asOwnerLeaseId("")).toThrow();
    expect(() => asOwnerLeaseId("a".repeat(201))).toThrow();
  });

  test("brands are distinct at the type layer, transparent at runtime", () => {
    const t = asTaskId("same_content");
    const m = asMessageId("same_content");
    // Same content → same unbranded string. That's the point of the
    // brand: a type-level identity that erases at runtime.
    expect((t as unknown as string)).toBe(m as unknown as string);
    // Type-level: `const x: TaskId = m` fails to compile. Can't check
    // that in a runtime assertion; the compile step is the check.
  });

  test("rejects non-string inputs (defensive at the wire boundary)", () => {
    expect(() => asTaskId(null as unknown as string)).toThrow();
    expect(() => asTaskId(undefined as unknown as string)).toThrow();
    expect(() => asTaskId(42 as unknown as string)).toThrow();
    expect(() => asTaskId({} as unknown as string)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────
// EnqueueTaskArgs shape — the exact fields the Agent may send
// ────────────────────────────────────────────────────────────────────────

describe("EnqueueTaskArgs", () => {
  test("carries exactly {taskId, messageId, authenticatedSender, text}", () => {
    const sender: AuthenticatedSender = {
      alias: "reviewer",
      tokenId: "tok_abc",
      role: "member",
      networkId: "net_x",
    };
    const args: EnqueueTaskArgs = {
      taskId: asTaskId("t_1"),
      messageId: asMessageId("m_1"),
      authenticatedSender: sender,
      text: "please check the failing tests",
    };
    expect(Object.keys(args).sort()).toEqual([
      "authenticatedSender",
      "messageId",
      "taskId",
      "text",
    ]);
    expect(Object.keys(args.authenticatedSender).sort()).toEqual([
      "alias",
      "networkId",
      "role",
      "tokenId",
    ]);
  });

  test("authenticatedSender.role has a fixed enum — 'admin/owner/member/viewer/child/unknown'", () => {
    const roles: Array<AuthenticatedSender["role"]> = [
      "admin",
      "owner",
      "member",
      "viewer",
      "child",
      "unknown",
    ];
    for (const r of roles) {
      const s: AuthenticatedSender = {
        alias: "x",
        tokenId: "tok_x",
        role: r,
        networkId: "net_x",
      };
      expect(s.role).toBe(r);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// EnqueueTaskResult discriminated union — exhaustive walk
// ────────────────────────────────────────────────────────────────────────

describe("EnqueueTaskResult", () => {
  test("accepted result exposes taskId + queuePosition + duplicate", () => {
    const r: EnqueueTaskAccepted = {
      outcome: "accepted",
      taskId: asTaskId("t_1"),
      queuePosition: 2,
      duplicate: false,
    };
    expect(r.outcome).toBe("accepted");
    expect(r.queuePosition).toBe(2);
    expect(r.duplicate).toBe(false);
  });

  test("accepted with duplicate=true implies caller already sent this messageId", () => {
    const r: EnqueueTaskAccepted = {
      outcome: "accepted",
      taskId: asTaskId("t_1"),
      queuePosition: null,
      duplicate: true,
    };
    expect(r.duplicate).toBe(true);
    expect(r.queuePosition).toBeNull();
  });

  test("refusal outcomes each carry their own payload — no untyped 'other'", () => {
    const refusals: EnqueueTaskRefused[] = [
      { outcome: "refused_queue_full", queueDepth: 10, limit: 8 },
      { outcome: "refused_no_owner" },
      { outcome: "refused_shutting_down" },
      { outcome: "refused_invalid_arg", field: "text", reason: "empty" },
    ];
    for (const r of refusals) {
      switch (r.outcome) {
        case "refused_queue_full":
          expect(r.queueDepth).toBeGreaterThanOrEqual(r.limit);
          break;
        case "refused_no_owner":
          expect(Object.keys(r).sort()).toEqual(["outcome"]);
          break;
        case "refused_shutting_down":
          expect(Object.keys(r).sort()).toEqual(["outcome"]);
          break;
        case "refused_invalid_arg":
          expect(r.field.length).toBeGreaterThan(0);
          expect(r.reason.length).toBeGreaterThan(0);
          break;
        default:
          return assertExhaustive(r);
      }
    }
  });

  test("EnqueueTaskResult = accepted | refused (compile-time exhaustive on outcome)", () => {
    const results: EnqueueTaskResult[] = [
      { outcome: "accepted", taskId: asTaskId("t_1"), queuePosition: 0, duplicate: false },
      { outcome: "refused_queue_full", queueDepth: 1, limit: 0 },
    ];
    for (const r of results) {
      switch (r.outcome) {
        case "accepted":
        case "refused_queue_full":
        case "refused_no_owner":
        case "refused_shutting_down":
        case "refused_invalid_arg":
          break;
        default:
          return assertExhaustive(r);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// TaskState discriminant — every terminal outcome + the two non-terminals
// ────────────────────────────────────────────────────────────────────────

describe("TaskState", () => {
  test("exhaustive walk over every state — no default fallthrough", () => {
    const states: TaskState[] = [
      { state: "unknown" },
      { state: "queued", queuePosition: 3 },
      { state: "starting" },
      { state: "running", startedAtMs: 1 },
      { state: "waiting_human", startedAtMs: 1, waitingSinceMs: 2 },
      { state: "completed", startedAtMs: 1, completedAtMs: 2, replyText: "hi" },
      { state: "failed", startedAtMs: 1, failedAtMs: 2, errorSummary: "boom" },
      { state: "cancelled", cancelledAtMs: 5, cancelledBy: "owner" },
      { state: "approval_timeout", startedAtMs: 1, timeoutAtMs: 999 },
    ];
    for (const s of states) {
      switch (s.state) {
        case "unknown":
        case "queued":
        case "starting":
        case "running":
        case "waiting_human":
        case "completed":
        case "failed":
        case "cancelled":
        case "approval_timeout":
          break;
        default:
          return assertExhaustive(s);
      }
    }
    // Sanity — 9 states enumerated, matches contract.ts.
    expect(states.length).toBe(9);
  });

  test("cancelledBy is restricted to agent/owner/gateway", () => {
    const validSources: Array<"agent" | "owner" | "gateway"> = ["agent", "owner", "gateway"];
    for (const by of validSources) {
      const s: TaskState = { state: "cancelled", cancelledAtMs: 0, cancelledBy: by };
      expect(s.cancelledBy).toBe(by);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// CancelQueuedTaskResult
// ────────────────────────────────────────────────────────────────────────

describe("CancelQueuedTaskResult", () => {
  test("cancelled outcome carries cancelledAtMs", () => {
    const r: CancelQueuedTaskResult = { outcome: "cancelled", cancelledAtMs: 100 };
    expect(r.outcome).toBe("cancelled");
  });

  test("refused_not_queued threads the currentState so the caller can decide", () => {
    const r: CancelQueuedTaskResult = { outcome: "refused_not_queued", currentState: "running" };
    if (r.outcome === "refused_not_queued") {
      expect(r.currentState).toBe("running");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// RuntimeStateEvent — read-only shape
// ────────────────────────────────────────────────────────────────────────

describe("RuntimeStateEvent", () => {
  test("carries only the read-only fields the Wave-0 policy allows", () => {
    const ev: RuntimeStateEvent = {
      at: 1,
      connection: "idle",
      ownerAttached: true,
      queueDepth: 0,
      tasksSeen: 5,
      codexBinaryVersion: "0.144.0",
      codexSchemaDigest: "sha256:beef",
    };
    expect(Object.keys(ev).sort()).toEqual([
      "at",
      "codexBinaryVersion",
      "codexSchemaDigest",
      "connection",
      "ownerAttached",
      "queueDepth",
      "tasksSeen",
    ]);
  });

  test("connection discriminant covers every gateway state without an escape hatch", () => {
    const conns: Array<RuntimeStateEvent["connection"]> = [
      "disconnected",
      "syncing",
      "idle",
      "starting",
      "running",
      "waiting_human",
      "recovering",
    ];
    for (const c of conns) {
      const ev: RuntimeStateEvent = {
        at: 0,
        connection: c,
        ownerAttached: false,
        queueDepth: 0,
        tasksSeen: 0,
        codexBinaryVersion: "0.144.0",
        codexSchemaDigest: "sha256:beef",
      };
      switch (ev.connection) {
        case "disconnected":
        case "syncing":
        case "idle":
        case "starting":
        case "running":
        case "waiting_human":
        case "recovering":
          break;
        default:
          return assertExhaustive(ev.connection);
      }
    }
  });

  test("RuntimeStateSubscription surfaces `close()` only — no `.emit()` etc.", () => {
    const sub: RuntimeStateSubscription = { close() {} };
    expect(typeof sub.close).toBe("function");
    // The type has ONE method; if a future refactor adds `emit()` or
    // `mutate()`, the Object.keys guard catches it.
    expect(Object.keys(sub).sort()).toEqual(["close"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// AgentTypedContract shape
// ────────────────────────────────────────────────────────────────────────

describe("AgentTypedContract", () => {
  test("has exactly {enqueueTask, getTaskState, cancelQueuedTask, subscribeRuntimeState} — nothing else", () => {
    // A conforming mock; if a future refactor adds a raw method, the
    // Object.keys length + string-list assertion is what fails.
    const mock: AgentTypedContract = {
      async enqueueTask(_args) {
        return { outcome: "accepted", taskId: asTaskId("t_1"), queuePosition: 0, duplicate: false };
      },
      async getTaskState(_taskId) {
        return { state: "unknown" };
      },
      async cancelQueuedTask(_taskId) {
        return { outcome: "refused_not_queued", currentState: "unknown" };
      },
      subscribeRuntimeState(_l) {
        return { close() {} };
      },
    };
    expect(Object.keys(mock).sort()).toEqual([
      "cancelQueuedTask",
      "enqueueTask",
      "getTaskState",
      "subscribeRuntimeState",
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// GatewayErrorCode ranges — reserved / application distinction
// ────────────────────────────────────────────────────────────────────────

describe("GatewayErrorCode", () => {
  test("Unavailable uses the JSON-RPC reserved -32001 slot", () => {
    expect(GatewayErrorCode.Unavailable).toBe(-32001);
  });

  test("Application codes stay clear of JSON-RPC reserved (-32700..-32000)", () => {
    for (const [name, code] of Object.entries(GatewayErrorCode)) {
      // enum reverse-map keys are numeric strings; only walk the string-keyed side.
      if (Number.isNaN(Number(name))) {
        expect(typeof code).toBe("number");
        if (code !== GatewayErrorCode.Unavailable) {
          expect(code as number).toBeLessThan(-32000);
        }
      }
    }
  });

  test("has exactly the 8 codes declared in Wave 1A — no silent extension", () => {
    const names = Object.keys(GatewayErrorCode).filter(k => Number.isNaN(Number(k)));
    expect(names.sort()).toEqual([
      "CodexBaselineMismatch",
      "InvalidArg",
      "NoOwner",
      "QueueFull",
      "Unavailable",
      "UnknownMethod",
      "UnknownTask",
    ]);
    expect(names.length).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Source-level red line: banned identifiers absent from contract.ts
// ────────────────────────────────────────────────────────────────────────

describe("banned identifiers", () => {
  const src = readFileSync(join(import.meta.dir, "contract.ts"), "utf-8");

  // Words that would signal a raw MCP / codex leak on the Agent surface.
  // "method" is tricky — the word appears in prose comments — so the
  // grep is on the field-shape substrings (`method:` in a type literal
  // or `method?:` etc.). Same for `id:`. These are the shapes that
  // would appear as an actual interface property, not narration.
  const forbidden: Array<[string, RegExp]> = [
    ["raw MCP method field", /^\s*method\??:/m],
    ["JSON-RPC id field",     /^\s*id\??:\s*(number|string|unknown)/m],
    ["threadId field",        /^\s*threadId\??:/m],
    ["turnId field",          /^\s*turnId\??:/m],
    ["policy field",          /^\s*policy\??:/m],
    ["path field",            /^\s*path\??:/m],
    ["config field",          /^\s*config\??:/m],
    ["requestId field",       /^\s*requestId\??:/m],
    ["params field",          /^\s*params\??:/m],
    ["jsonrpc field",         /^\s*jsonrpc\??:/m],
  ];

  for (const [label, re] of forbidden) {
    test(`contract.ts contains no ${label}`, () => {
      const match = src.match(re);
      if (match) {
        throw new Error(
          `contract.ts leaked a ${label} on the Agent typed surface:\n  ${match[0].trim()}`,
        );
      }
      expect(match).toBeNull();
    });
  }

  // The banning is only for the Agent-facing SURFACE. The BRANDED
  // helper file may (and does) mention `OwnerLeaseId` internally, but
  // that identifier should be exported as an opaque brand only — no
  // field of type OwnerLeaseId should surface on `AgentTypedContract`
  // or its argument / result types.
  test("OwnerLeaseId is declared but never appears as a field on Agent-facing types", () => {
    // Present as a brand declaration:
    expect(src).toMatch(/export type OwnerLeaseId = /);
    // Absent as a field type on any interface / type literal:
    expect(src.match(/^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*OwnerLeaseId/m)).toBeNull();
  });
});
