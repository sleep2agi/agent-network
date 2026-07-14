import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const scratch = mkdtempSync(join(tmpdir(), "rfc030-entry-pre-h1-"));
process.env.COMMHUB_DB = join(scratch, "commhub.db");
process.env.HOST = "127.0.0.1";
const PORT = 23000 + Math.floor(Math.random() * 1000);
process.env.PORT = String(PORT);

const { db } = await import("../../server/src/db");
const { issueUserToken, createNetworkTokenForNode } = await import(
  "../../server/src/auth"
);
const { injectOrdinaryInboxRow, runGatewayInboxCycle } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/inbox-pump"
);
const { GatewayLedger } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/ledger"
);
const { GatewayScheduler } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/scheduler"
);
const { resolveSqliteDriver } = await import(
  "../../agent-node/src/runtime/codex-policy-gateway/sqlite-driver"
);

const NET = "net_stage2_entry";
const USER_ID = "u_stage2_entry";
const USERNAME = "stage2-entry-user";
const GATEWAY = "stage2-gateway";
const ROGUE = "stage2-other-node";
const BASE = `http://127.0.0.1:${PORT}`;

db.run(
  `INSERT INTO users (user_id, username, password_hash, role)
   VALUES (?1, ?2, 'not-used', 'user')`,
  [USER_ID, USERNAME],
);
db.run(
  `INSERT INTO networks (network_id, network_name, owner_id)
   VALUES (?1, 'stage2-entry-network', ?2)`,
  [NET, USER_ID],
);
db.run(
  `INSERT INTO network_members (network_id, user_id, role)
   VALUES (?1, ?2, 'member')`,
  [NET, USER_ID],
);
for (const alias of [USERNAME, GATEWAY, ROGUE]) {
  db.run(
    `INSERT INTO sessions
       (resume_id, alias, network_id, status, last_seen_at, updated_at)
     VALUES (?1, ?2, ?3, 'idle', datetime('now'), datetime('now'))`,
    [`resume-${alias}`, alias, NET],
  );
}

const userToken = issueUserToken(USER_ID, "stage2-entry-wire");
const gatewayMint = createNetworkTokenForNode(USER_ID, NET, GATEWAY);
const rogueMint = createNetworkTokenForNode(USER_ID, NET, ROGUE);
if (!gatewayMint.ok || !gatewayMint.token || !rogueMint.ok || !rogueMint.token) {
  throw new Error("failed to mint test network tokens");
}

await import("../../server/src/index");

type JsonObject = Record<string, unknown>;

async function openMcp(rawToken: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${rawToken}` },
    },
  });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonObject> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof (entry as { text?: unknown }).text === "string",
  );
  if (!block) throw new Error(`tool ${name} returned no text block`);
  return JSON.parse(block.text) as JsonObject;
}

async function postTask(rawToken: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${BASE}/api/task`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${rawToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as JsonObject;
  expect(response.status).toBeLessThan(300);
  return payload;
}

interface SseProbe {
  next(type: string, timeoutMs?: number): Promise<JsonObject>;
  close(): void;
}

async function openSse(rawToken: string): Promise<SseProbe> {
  const controller = new AbortController();
  const response = await fetch(
    `${BASE}/events/${encodeURIComponent(GATEWAY)}?network_id=${encodeURIComponent(NET)}`,
    {
      headers: { Authorization: `Bearer ${rawToken}` },
      signal: controller.signal,
    },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const queued: JsonObject[] = [];

  const parseBuffered = () => {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary < 0) return;
      const packet = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = packet
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      queued.push(JSON.parse(data) as JsonObject);
    }
  };

  return {
    async next(type: string, timeoutMs = 5_000): Promise<JsonObject> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = queued.findIndex((event) => event.type === type);
        if (found >= 0) return queued.splice(found, 1)[0]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`SSE ${type} timeout`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`SSE ${type} timeout`)), remaining),
          ),
        ]);
        if (chunk.done) throw new Error(`SSE closed before ${type}`);
        buffered += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        parseBuffered();
      }
    },
    close(): void {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

function findMessage(payload: JsonObject, id: string): JsonObject {
  const messages = payload.messages as JsonObject[];
  const row = messages.find((entry) => entry.id === id);
  if (!row) throw new Error(`inbox response missing ${id}`);
  return row;
}

describe("RFC-030 Stage2 real server entries (pre-#440 H1)", () => {
  test("MCP + REST stamp one canonical inbox; SSE is only a doorbell; mixed cycle closes a durable reply", async () => {
    const user = await openMcp(userToken.token, "stage2-entry-user-client");
    const gateway = await openMcp(gatewayMint.token!, "stage2-entry-gateway-client");
    const rogue = await openMcp(rogueMint.token!, "stage2-entry-boundary-client");
    const sse = await openSse(gatewayMint.token!);

    const mcpSent = await callTool(user, "send_task", {
      alias: GATEWAY,
      task: "mcp canonical task",
      priority: "high",
      network_id: NET,
    });
    expect(mcpSent.ok).toBe(true);
    const mcpId = String(mcpSent.message_id);

    const restSent = await postTask(userToken.token, {
      alias: GATEWAY,
      task: "rest canonical task",
      priority: "normal",
      from: USERNAME,
      network_id: NET,
    });
    expect(restSent.ok).toBe(true);
    const restId = String(restSent.task_id);

    // Both real ingress paths woke the same channel. A doorbell does not
    // carry/claim a row and therefore must not change durable ACK state.
    await sse.next("new_task");
    await sse.next("new_task");
    for (const id of [mcpId, restId]) {
      const durable = db.get<JsonObject>("SELECT * FROM inbox WHERE id = ?1", id)!;
      expect(durable.acked).toBe(0);
      expect(durable.session_name).toBe(GATEWAY);
      expect(durable.network_id).toBe(NET);
      expect(durable.sender_token_id).toBe(userToken.token_id);
      expect(durable.sender_role).toBe("member");
      expect(durable.canonical_task_id).toBe(id);
      const task = db.get<JsonObject>("SELECT * FROM tasks WHERE task_id = ?1", id)!;
      expect(task.origin_sender_token_id).toBe(userToken.token_id);
      expect(task.origin_sender_role).toBe("member");
    }

    const inbox = await callTool(gateway, "get_inbox", { alias: GATEWAY, limit: 20 });
    expect(inbox.ok).toBe(true);
    for (const id of [mcpId, restId]) {
      const row = findMessage(inbox, id);
      expect(row.sender_token_id).toBe(userToken.token_id);
      expect(row.sender_role).toBe("member");
      expect(row.canonical_task_id).toBe(id);
    }

    // Exact H1 blocker: today a DIFFERENT node token in the same network
    // can pull this alias without presenting a consumer lease. This is a
    // read-only probe. The suite is deliberately named pre-H1 and must be
    // replaced once #440 makes this call a structured refusal.
    const preH1Read = await callTool(rogue, "get_inbox", { alias: GATEWAY, limit: 20 });
    expect(preH1Read.ok).toBe(true);
    expect((preH1Read.messages as JsonObject[]).some((row) => row.id === mcpId)).toBe(true);
    console.log(
      "PRE_H1_BOUNDARY: second network-bound node principal read gateway inbox without consumer lease",
    );

    const invalidSent = await callTool(user, "send_task", {
      alias: GATEWAY,
      task: "invalid task for atomic dead-letter",
      priority: "low",
      network_id: NET,
    });
    expect(invalidSent.ok).toBe(true);
    const invalidId = String(invalidSent.message_id);

    const ordinarySent = await callTool(user, "send_message", {
      alias: GATEWAY,
      message: "ordinary mixed-window message",
    });
    expect(ordinarySent.ok).toBe(true);
    const ordinaryId = String(ordinarySent.message_id);

    const mixed = await callTool(gateway, "get_inbox", { alias: GATEWAY, limit: 20 });
    const ledgerPath = join(scratch, "gateway-ledger.db");
    const firstResolution = resolveSqliteDriver(ledgerPath);
    const ledger = new GatewayLedger(firstResolution.driver);
    let activeSubmission = "";
    const scheduler = new GatewayScheduler({
      ledger,
      ownerAttached: () => true,
      dispatcher: {
        startTurn: async ({ submissionId }) => {
          activeSubmission = submissionId;
          return { kind: "accepted", turnId: `turn-${submissionId}` } as const;
        },
      },
    });

    const report = await runGatewayInboxCycle(
      mixed.messages as never,
      {
        enqueueTask: async (args) => {
          if (String(args.messageId) === invalidId) {
            return {
              outcome: "refused_invalid_arg",
              field: "text",
              reason: "pre-H1 mutation probe",
            } as const;
          }
          return scheduler.enqueueTask(args);
        },
      },
      {
        ack: async (messageId) => {
          const result = await callTool(gateway, "ack_inbox", {
            alias: GATEWAY,
            message_id: messageId,
          });
          expect(result.ok).toBe(true);
        },
        deadLetter: async (request) => {
          const result = await callTool(gateway, "gateway_dead_letter", {
            message_id: request.messageId,
            canonical_task_id: request.canonicalTaskId ?? undefined,
            reason: `codex_gateway_${request.reason}`,
          });
          expect(result.ok).toBe(true);
          return { outcome: result.outcome as "dead_lettered" | "quarantined" | "not_found" };
        },
      },
      async (row) => {
        expect(row.id).toBe(ordinaryId);
        const disposition = await injectOrdinaryInboxRow(row, scheduler, {
          ack: async (messageId) => {
            const acked = await callTool(gateway, "ack_inbox", {
              alias: GATEWAY,
              message_id: messageId,
            });
            expect(acked.ok).toBe(true);
          },
          quarantine: async () => {
            throw new Error("valid stamped ordinary message must not be quarantined");
          },
        });
        expect(disposition.outcome).toBe("accepted");
      },
    );

    expect(report.ordinaryDelivered).toBe(1);
    expect(ledger.get(ordinaryId)).toMatchObject({
      state: "queued",
      inboundType: "message",
      expectsReply: false,
      outboundDelivery: "none",
    });
    expect(report.enqueued.map((entry) => entry.messageId).sort()).toEqual(
      [mcpId, restId].sort(),
    );
    expect(report.deadLettered).toHaveLength(1);
    expect(report.deadLettered[0]!.messageId).toBe(invalidId);
    expect(report.deadLettered[0]!.result.outcome).toBe("dead_lettered");
    expect(db.get<JsonObject>("SELECT acked FROM inbox WHERE id = ?1", invalidId)!.acked).toBe(1);
    expect(db.get<JsonObject>("SELECT status FROM tasks WHERE task_id = ?1", invalidId)!.status).toBe("failed");
    expect(
      db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?1 AND to_status = 'failed'",
        invalidId,
      )!.count,
    ).toBeGreaterThanOrEqual(1);

    for (let attempt = 0; attempt < 50 && ledger.get(activeSubmission)?.state !== "accepted"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(activeSubmission).toBe(mcpId);
    expect(ledger.get(activeSubmission)!.state).toBe("accepted");
    // Completing the first row synchronously starts the next queued row and
    // therefore mutates `activeSubmission`; retain the canonical row whose
    // reply lifecycle this test is proving.
    const completedSubmission = activeSubmission;
    scheduler.onAgentTurnFinished(completedSubmission, {
      ok: true,
      replyText: "durable stage2 reply",
    });
    expect(ledger.get(completedSubmission)!.state).toBe("reply_pending");

    // Drain the remaining shared FIFO before closing the SQLite driver; a
    // live scheduler must never retain a DB handle across the reopen proof.
    for (let attempt = 0; attempt < 50 && ledger.get(restId)?.state !== "accepted"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(ledger.get(restId)!.state).toBe("accepted");
    scheduler.onAgentTurnFinished(restId, {
      ok: true,
      replyText: "secondary durable reply",
    });
    for (let attempt = 0; attempt < 50 && ledger.get(ordinaryId)?.state !== "accepted"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(ledger.get(ordinaryId)!.state).toBe("accepted");
    scheduler.onAgentTurnFinished(ordinaryId, {
      ok: true,
      replyText: "ordinary row consumed",
    });
    expect(ledger.get(ordinaryId)).toMatchObject({
      state: "replied",
      outboundDelivery: "none",
    });

    // Reopen the file before sending: reply_pending survived process-local
    // objects. Only a successful CommHub send_reply permits markReplied.
    firstResolution.driver.close();
    const recoveredResolution = resolveSqliteDriver(ledgerPath);
    const recoveredLedger = new GatewayLedger(recoveredResolution.driver);
    const recoveredScheduler = new GatewayScheduler({
      ledger: recoveredLedger,
      ownerAttached: () => true,
      dispatcher: {
        startTurn: async () => ({ kind: "failed", error: "not used" }),
      },
    });
    expect(recoveredLedger.get(completedSubmission)!.state).toBe("reply_pending");

    const refusedReply = await callTool(gateway, "send_reply", {
      alias: USERNAME,
      text: "must not mark replied",
      in_reply_to: `${mcpId}-missing`,
      status: "replied",
    });
    expect(refusedReply.ok).toBe(false);
    expect(recoveredLedger.get(completedSubmission)!.state).toBe("reply_pending");

    const deliveredReply = await callTool(gateway, "send_reply", {
      alias: USERNAME,
      text: "durable stage2 reply",
      in_reply_to: mcpId,
      status: "replied",
    });
    expect(deliveredReply.ok).toBe(true);
    recoveredScheduler.markReplied(completedSubmission);
    expect(recoveredLedger.get(completedSubmission)!.state).toBe("replied");
    const closedTask = db.get<JsonObject>(
      "SELECT status, result FROM tasks WHERE task_id = ?1",
      mcpId,
    )!;
    expect(closedTask.status).toBe("replied");
    expect(closedTask.result).toBe("durable stage2 reply");

    recoveredResolution.driver.close();
    sse.close();
    await Promise.all([user.close(), gateway.close(), rogue.close()]);
  }, 30_000);
});
