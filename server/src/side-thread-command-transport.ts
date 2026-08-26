import { createHash } from "node:crypto";
import type { DbAdapter } from "./db-adapter.js";
import {
  SideThreadError, type SideThreadAttachmentRef, type SideThreadCapability,
  type SideThreadExecutionPort, type SideThreadRuntimeEvent,
} from "./side-thread.js";

export const SIDE_THREAD_COMMAND_PROTOCOL = "side_thread.command.v1" as const;
export const SIDE_THREAD_ACK_PROTOCOL = "side_thread.ack.v1" as const;
export const SIDE_THREAD_TERMINAL_PROTOCOL = "side_thread.terminal.v1" as const;

type CommandState = "pending" | "delivered" | "accepted" | "ambiguous" | "failed" | "unsupported";
type CommandRow = {
  command_id: string; operation_id: string; request_key: string; network_id: string;
  node_id: string; side_chat_id: string; attempt_id: string | null; kind: string;
  fingerprint: string; command_json: string; status: CommandState;
  consumed_by_token: string | null; ack_json: string | null;
};

export type NodeCommandActor = { tokenId: string; networkId: string; nodeId: string };

export function installSideThreadCommandSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_thread_commands (
      command_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
      request_key TEXT NOT NULL, network_id TEXT NOT NULL, node_id TEXT NOT NULL,
      side_chat_id TEXT NOT NULL, attempt_id TEXT, kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL, command_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', consumed_by_token TEXT,
      ack_json TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_side_thread_commands_pending
      ON side_thread_commands(network_id,node_id,status,created_at);
    CREATE TABLE IF NOT EXISTS side_thread_terminal_receipts (
      side_chat_id TEXT NOT NULL, attempt_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, status TEXT NOT NULL, envelope_json TEXT NOT NULL,
      consumed_by_token TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(side_chat_id,attempt_id,thread_id,turn_id)
    );
  `);
}

export class SideThreadCommandStore {
  constructor(readonly db: DbAdapter, private readonly now = Date.now) {
    installSideThreadCommandSchema(db);
  }

  enqueue(command: Record<string, unknown>, scope: { networkId: string; nodeId: string }): CommandRow {
    const operationId = id(command.operationId, "operationId");
    const commandId = id(command.commandId, "commandId");
    const sideChatId = id(command.sideThreadId, "sideThreadId");
    const attemptId = command.attemptId === null ? null : id(command.attemptId, "attemptId");
    if (command.protocol !== SIDE_THREAD_COMMAND_PROTOCOL || command.nodeId !== scope.nodeId) throw new Error("invalid command envelope");
    const canonical = JSON.stringify(command);
    const fingerprint = sha(canonical);
    const old = this.db.get<CommandRow>("SELECT * FROM side_thread_commands WHERE operation_id=?1", operationId);
    if (old) {
      if (old.command_id !== commandId || old.fingerprint !== fingerprint || old.network_id !== scope.networkId || old.node_id !== scope.nodeId)
        throw new SideThreadError("SIDE_THREAD_CONFLICT", "operation identity reused with different command", 409, operationId, sideChatId, attemptId ?? undefined);
      return old;
    }
    this.db.run(
      `INSERT INTO side_thread_commands
       (command_id,operation_id,request_key,network_id,node_id,side_chat_id,attempt_id,kind,fingerprint,command_json,status,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)`,
      [commandId, operationId, id(command.requestKey, "requestKey"), scope.networkId, scope.nodeId,
       sideChatId, attemptId, id(command.kind, "kind"), fingerprint, canonical, this.now()],
    );
    return this.db.get<CommandRow>("SELECT * FROM side_thread_commands WHERE command_id=?1", commandId)!;
  }

  claim(actor: NodeCommandActor): Record<string, unknown> | null {
    return this.db.transaction(() => {
      const delivered = this.db.get<CommandRow>(
        "SELECT * FROM side_thread_commands WHERE network_id=?1 AND node_id=?2 AND status='delivered' AND consumed_by_token=?3 ORDER BY delivered_at LIMIT 1",
        actor.networkId, actor.nodeId, actor.tokenId,
      );
      if (delivered) return JSON.parse(delivered.command_json);
      const row = this.db.get<CommandRow>(
        "SELECT * FROM side_thread_commands WHERE network_id=?1 AND node_id=?2 AND status='pending' ORDER BY created_at,command_id LIMIT 1",
        actor.networkId, actor.nodeId,
      );
      if (!row) return null;
      const changed = this.db.run(
        "UPDATE side_thread_commands SET status='delivered',consumed_by_token=?1,delivered_at=?2 WHERE command_id=?3 AND status='pending'",
        [actor.tokenId, this.now(), row.command_id],
      );
      return changed.changes === 1 ? JSON.parse(row.command_json) : null;
    });
  }

  ack(actor: NodeCommandActor, raw: unknown): { idempotent: boolean; ack: Record<string, unknown> } {
    const ack = object(raw);
    if (ack.protocol !== SIDE_THREAD_ACK_PROTOCOL) throw new Error("invalid ack protocol");
    const commandId = id(ack.commandId, "commandId"), operationId = id(ack.operationId, "operationId");
    if (!["accepted", "ambiguous", "failed", "unsupported"].includes(String(ack.state))) throw new Error("invalid ack state");
    const canonical = JSON.stringify(ack);
    return this.db.transaction(() => {
      const row = this.db.get<CommandRow>("SELECT * FROM side_thread_commands WHERE command_id=?1", commandId);
      if (!row || row.operation_id !== operationId || row.network_id !== actor.networkId || row.node_id !== actor.nodeId
        || row.consumed_by_token !== actor.tokenId) throw new Error("command ownership mismatch");
      if (row.ack_json) {
        if (row.ack_json !== canonical) throw new Error("command ack is immutable");
        return { idempotent: true, ack };
      }
      if (row.status !== "delivered") throw new Error("command was not delivered");
      this.assertAckOwnership(row, ack);
      const changed = this.db.run(
        "UPDATE side_thread_commands SET status=?1,ack_json=?2,acked_at=?3 WHERE command_id=?4 AND status='delivered' AND consumed_by_token=?5",
        [ack.state, canonical, this.now(), commandId, actor.tokenId],
      );
      if (changed.changes !== 1) throw new Error("command ack race");
      return { idempotent: false, ack };
    });
  }

  terminal(actor: NodeCommandActor, raw: unknown): { idempotent: boolean; event: SideThreadRuntimeEvent } {
    const env = object(raw);
    if (env.protocol !== SIDE_THREAD_TERMINAL_PROTOCOL) throw new Error("invalid terminal protocol");
    const sideChatId = id(env.sideThreadId, "sideThreadId"), attemptId = id(env.attemptId, "attemptId");
    const threadId = id(env.threadId, "threadId"), turnId = id(env.turnId, "turnId");
    const command = this.db.get<CommandRow>(
      "SELECT * FROM side_thread_commands WHERE network_id=?1 AND node_id=?2 AND side_chat_id=?3 AND attempt_id=?4 AND kind='start' AND status='accepted' ORDER BY acked_at DESC LIMIT 1",
      actor.networkId, actor.nodeId, sideChatId, attemptId,
    );
    if (!command || command.consumed_by_token !== actor.tokenId) throw new Error("terminal ownership mismatch");
    const ack = object(JSON.parse(command.ack_json!));
    const cmd = object(JSON.parse(command.command_json));
    if (object(ack.result).turnId !== turnId || object(cmd.payload).threadId !== threadId) throw new Error("terminal four-tuple mismatch");
    if (!["completed", "failed", "interrupted"].includes(String(env.status))) throw new Error("invalid terminal status");
    const event: SideThreadRuntimeEvent = {
      sideChatId, attemptId, threadId, turnId, status: env.status as any,
      ...(env.status === "completed" ? { text: typeof env.text === "string" ? env.text : "" } : {}),
      ...(env.status === "failed" ? { error: String(env.errorCode ?? "SIDE_THREAD_RUNTIME_FAILED") } : {}),
    };
    const canonical = JSON.stringify(env);
    try {
      this.db.run(
        "INSERT INTO side_thread_terminal_receipts (side_chat_id,attempt_id,thread_id,turn_id,status,envelope_json,consumed_by_token,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        [sideChatId, attemptId, threadId, turnId, env.status, canonical, actor.tokenId, this.now()],
      );
      return { idempotent: false, event };
    } catch {
      const prior = this.db.get<{ envelope_json: string; consumed_by_token: string }>(
        "SELECT envelope_json,consumed_by_token FROM side_thread_terminal_receipts WHERE side_chat_id=?1 AND attempt_id=?2 AND thread_id=?3 AND turn_id=?4",
        sideChatId, attemptId, threadId, turnId,
      );
      if (!prior || prior.envelope_json !== canonical || prior.consumed_by_token !== actor.tokenId) throw new Error("terminal receipt is immutable");
      return { idempotent: true, event };
    }
  }

  receipt(operationId: string): Record<string, unknown> | null {
    const row = this.db.get<CommandRow>("SELECT * FROM side_thread_commands WHERE operation_id=?1", operationId);
    return row?.ack_json ? JSON.parse(row.ack_json) : null;
  }

  private assertAckOwnership(row: CommandRow, ack: Record<string, unknown>): void {
    const command = object(JSON.parse(row.command_json));
    const result = object(ack.result);
    if (ack.state !== "accepted") return;
    if (row.kind === "fork" && !isId(result.threadId)) throw new Error("fork ack missing thread identity");
    if (row.kind === "start" && (!row.attempt_id || !isId(result.turnId) || !isId(object(command.payload).threadId)))
      throw new Error("start ack missing ownership tuple");
    if (row.kind === "bring-back" && !isId(result.destinationTurnId)) throw new Error("bring-back ack missing destination identity");
  }
}

/** Durable command outbox port. It has no task/inbox/FIFO dependency. */
export class DurableSideThreadCommandPort implements SideThreadExecutionPort {
  private listeners = new Set<(event: SideThreadRuntimeEvent) => void>();
  constructor(private readonly opts: {
    store: SideThreadCommandStore;
    networkForNode: (nodeId: string) => string | null;
    capabilityForNode: (nodeId: string) => SideThreadCapability;
    grantAttachment: (nodeId: string, ref: SideThreadAttachmentRef) => Record<string, unknown>;
  }) {}
  capability(nodeId: string) { return this.opts.capabilityForNode(nodeId); }
  fork(input: Parameters<SideThreadExecutionPort["fork"]>[0]) { return this.issue(input, "fork", { sourceThreadId: input.sourceThreadId, boundary: input.boundary }, "threadId") as Promise<{threadId:string}>; }
  start(input: Parameters<SideThreadExecutionPort["start"]>[0]) { return this.issue(input, "start", { threadId: input.threadId, question: input.prompt, attachments: input.attachments.map((x) => this.opts.grantAttachment(input.nodeId, x)) }, "turnId") as Promise<{turnId:string}>; }
  async cancel(input: Parameters<SideThreadExecutionPort["cancel"]>[0]) { await this.issue(input, "cancel", { threadId: input.threadId, turnId: input.turnId }); }
  async archive(input: Parameters<SideThreadExecutionPort["archive"]>[0]) { await this.issue(input, "archive", { threadId: input.threadId }); }
  async purge(input: Parameters<SideThreadExecutionPort["purge"]>[0]) { await this.issue(input, "purge", { threadId: input.threadId }); }
  bringBack(input: Parameters<SideThreadExecutionPort["bringBack"]>[0]) { return this.issue(input, "bring-back", { sourceThreadId: input.sourceThreadId, sourceTurnId: input.sourceTurnId, destinationThreadId: input.destinationThreadId, text: input.text }, "destinationTurnId") as Promise<{destinationTurnId:string}>; }
  subscribe(listener: (event: SideThreadRuntimeEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  acceptTerminal(actor: NodeCommandActor, raw: unknown) { const x = this.opts.store.terminal(actor, raw); if (!x.idempotent) for (const listener of this.listeners) listener(x.event); return x; }
  private async issue(input: any, kind: string, payload: Record<string, unknown>, resultKey?: string): Promise<any> {
    const networkId = this.opts.networkForNode(input.nodeId);
    if (!networkId) throw new SideThreadError("SIDE_THREAD_NOT_FOUND", "node not found", 404);
    const commandId = `stc_${sha(input.operationId).slice(7)}`;
    const command = { protocol: SIDE_THREAD_COMMAND_PROTOCOL, commandId, operationId: input.operationId,
      requestKey: input.requestKey ?? input.operationId, nodeId: input.nodeId, sideThreadId: input.sideChatId,
      attemptId: input.attemptId ?? null, kind, payload };
    this.opts.store.enqueue(command, { networkId, nodeId: input.nodeId });
    const receipt = this.opts.store.receipt(input.operationId);
    if (!receipt) throw new SideThreadError("SIDE_THREAD_AMBIGUOUS", "command durably queued; awaiting node ACK", 202, input.operationId, input.sideChatId, input.attemptId);
    if (receipt.state === "accepted") return resultKey ? { [resultKey]: object(receipt.result)[resultKey] } : undefined;
    throw new SideThreadError(receipt.errorCode === "SIDE_THREAD_UNSUPPORTED" ? "SIDE_THREAD_UNSUPPORTED" : "SIDE_THREAD_AMBIGUOUS", "node command did not complete synchronously", receipt.errorCode === "SIDE_THREAD_UNSUPPORTED" ? 501 : 202, input.operationId, input.sideChatId, input.attemptId);
  }
}

export async function handleSideThreadCommandRequest(input: {
  req: Request; url: URL; actor: NodeCommandActor | null;
  store: SideThreadCommandStore; port: DurableSideThreadCommandPort;
}): Promise<Response | null> {
  const match = input.url.pathname.match(/^\/api\/nodes\/([^/]+)\/side-thread-commands(?:\/(pending|terminals|([^/]+)\/ack))?$/);
  if (!match) return null;
  if (!input.actor) return Response.json({ ok: false, error: "node_token_binding_required" }, { status: 403 });
  let nodeId: string;
  try { nodeId = decodeURIComponent(match[1]); } catch { return Response.json({ ok: false, error: "invalid_node_id" }, { status: 400 }); }
  if (nodeId !== input.actor.nodeId || !isId(nodeId)) return Response.json({ ok: false, error: "node_token_binding_required" }, { status: 403 });
  try {
    if (match[2] === "pending" && input.req.method === "GET")
      return Response.json({ ok: true, command: input.store.claim(input.actor) });
    if (match[2] === "terminals" && input.req.method === "POST") {
      const result = input.port.acceptTerminal(input.actor, await input.req.json());
      return Response.json({ ok: true, idempotent: result.idempotent });
    }
    if (match[3] && input.req.method === "POST") {
      const body = object(await input.req.json());
      if (body.commandId !== decodeURIComponent(match[3])) throw new Error("command path/body mismatch");
      const result = input.store.ack(input.actor, body);
      return Response.json({ ok: true, idempotent: result.idempotent });
    }
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: "invalid_side_thread_command", message: error instanceof Error ? error.message : "invalid request" }, { status: 409 });
  }
}

function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required"); return value as any; }
function isId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value); }
function id(value: unknown, label: string): string { if (!isId(value)) throw new Error(`invalid ${label}`); return value; }
function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
