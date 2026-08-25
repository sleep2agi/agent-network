import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DbAdapter } from "./db-adapter.js";

export const SIDE_THREAD_FEATURE_FLAG = "COMMHUB_ENABLE_SIDE_THREADS";
export const SIDE_THREAD_API_ROOT = "/api/side-threads";
export const SIDE_THREAD_EVENTS_SUFFIX = "/events";
export const SIDE_THREAD_API_ACTIONS = [
  "cancel",
  "retry",
  "archive",
  "purge",
  "bring-back",
  SIDE_THREAD_EVENTS_SUFFIX.slice(1),
] as const;

export type SideThreadState =
  | "creating"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "ambiguous"
  | "reconciling"
  | "archived"
  | "purged";
export type SideThreadAttemptState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "ambiguous"
  | "reconciling";
export type SideThreadBoundary =
  { kind: "through"; turnId: string } | { kind: "before"; turnId: string };

export interface SideThreadActor {
  userId: string;
  username: string;
  tokenId: string;
  kind: "user" | "node";
  boundNetworkId?: string;
  boundNodeId?: string;
  isAdmin?: boolean;
}

export interface SideThreadAttachmentRef {
  fileId: string;
}

export interface SideThreadCapability {
  supported: boolean;
  mode?: "native-exact-fork";
  runtime?: string;
  runtimeVersion?: string;
  topology?: string;
  evidenceRevision?: string;
  exactBoundary?: { through: boolean; before: boolean };
  reason?: string;
}

export interface SideThreadRuntimeEvent {
  sideChatId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text?: string;
  error?: string;
}

/**
 * The only bridge from Hub state into a runtime. Implementations must use a
 * native exact-boundary side-thread mechanism. Ordinary task/inbox/FIFO
 * delivery is deliberately absent from this interface.
 */
export interface SideThreadExecutionPort {
  capability(
    nodeId: string,
  ): Promise<SideThreadCapability> | SideThreadCapability;
  fork(input: {
    operationId: string;
    requestKey: string;
    sideChatId: string;
    nodeId: string;
    sourceThreadId: string;
    boundary: SideThreadBoundary;
  }): Promise<{ threadId: string }>;
  start(input: {
    operationId: string;
    requestKey: string;
    sideChatId: string;
    attemptId: string;
    nodeId: string;
    threadId: string;
    prompt: string;
    attachments: SideThreadAttachmentRef[];
  }): Promise<{ turnId: string }>;
  cancel(input: {
    operationId: string;
    sideChatId: string;
    attemptId: string;
    nodeId: string;
    threadId: string;
    turnId: string;
  }): Promise<void>;
  archive(input: {
    operationId: string;
    sideChatId: string;
    nodeId: string;
    threadId: string;
  }): Promise<void>;
  purge(input: {
    operationId: string;
    sideChatId: string;
    nodeId: string;
    threadId: string;
  }): Promise<void>;
  bringBack(input: {
    operationId: string;
    sideChatId: string;
    attemptId: string;
    nodeId: string;
    sourceThreadId: string;
    sourceTurnId: string;
    destinationThreadId: string;
    requestKey: string;
    text: string;
  }): Promise<{ destinationTurnId: string }>;
  subscribe(listener: (event: SideThreadRuntimeEvent) => void): () => void;
}

export class SideThreadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly operationId?: string,
    readonly sideChatId?: string,
    readonly attemptId?: string,
  ) {
    super(message);
    this.name = "SideThreadError";
  }
}

export class UnsupportedSideThreadPort implements SideThreadExecutionPort {
  capability(): SideThreadCapability {
    return { supported: false, reason: "runtime-adapter-unavailable" };
  }
  private unsupported(): never {
    throw new SideThreadError(
      "SIDE_THREAD_UNSUPPORTED",
      "verified native SideThread adapter is unavailable",
      501,
    );
  }
  async fork(): Promise<never> {
    return this.unsupported();
  }
  async start(): Promise<never> {
    return this.unsupported();
  }
  async cancel(): Promise<never> {
    return this.unsupported();
  }
  async archive(): Promise<never> {
    return this.unsupported();
  }
  async purge(): Promise<never> {
    return this.unsupported();
  }
  async bringBack(): Promise<never> {
    return this.unsupported();
  }
  subscribe(): () => void {
    return () => {};
  }
}

/**
 * Process-local adapter seam. Production starts unsupported; a node/runtime
 * integration may install one verified adapter explicitly. Replacing it also
 * rewires terminal-event subscribers, so the coordinator never subscribes to
 * an untracked transport.
 */
export class SideThreadPortRegistry implements SideThreadExecutionPort {
  private delegate: SideThreadExecutionPort = new UnsupportedSideThreadPort();
  private readonly listeners = new Set<
    (event: SideThreadRuntimeEvent) => void
  >();
  private detach: () => void = () => {};
  install(port: SideThreadExecutionPort): () => void {
    this.detach();
    this.delegate = port;
    this.detach = port.subscribe((event) => {
      for (const listener of this.listeners) listener(event);
    });
    return () => {
      if (this.delegate !== port) return;
      this.detach();
      this.detach = () => {};
      this.delegate = new UnsupportedSideThreadPort();
    };
  }
  capability(nodeId: string) {
    return this.delegate.capability(nodeId);
  }
  fork(input: Parameters<SideThreadExecutionPort["fork"]>[0]) {
    return this.delegate.fork(input);
  }
  start(input: Parameters<SideThreadExecutionPort["start"]>[0]) {
    return this.delegate.start(input);
  }
  cancel(input: Parameters<SideThreadExecutionPort["cancel"]>[0]) {
    return this.delegate.cancel(input);
  }
  archive(input: Parameters<SideThreadExecutionPort["archive"]>[0]) {
    return this.delegate.archive(input);
  }
  purge(input: Parameters<SideThreadExecutionPort["purge"]>[0]) {
    return this.delegate.purge(input);
  }
  bringBack(input: Parameters<SideThreadExecutionPort["bringBack"]>[0]) {
    return this.delegate.bringBack(input);
  }
  subscribe(listener: (event: SideThreadRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface SideThreadRecord {
  sideChatId: string;
  requestKey: string;
  networkId: string;
  nodeId: string;
  ownerUserId: string;
  sourceThreadId: string;
  /** Owner-readable original BTW question, durably restored across windows. */
  question: string;
  boundary: SideThreadBoundary;
  threadId?: string;
  state: SideThreadState;
  activeAttemptId?: string;
  runtime?: string;
  runtimeVersion?: string;
  topology?: string;
  evidenceRevision?: string;
  attachments: SideThreadAttachmentRef[];
  attempts: SideThreadAttemptRecord[];
  bringBacks: SideThreadBringBackRecord[];
  operations: SideThreadOperationRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface SideThreadAttemptRecord {
  attemptId: string;
  requestKey: string;
  parentAttemptId?: string;
  threadId?: string;
  turnId?: string;
  state: SideThreadAttemptState;
  result?: string;
  error?: string;
  attachments: SideThreadAttachmentRef[];
  createdAt: number;
  updatedAt: number;
}

export interface SideThreadBringBackRecord {
  bringBackId: string;
  attemptId: string;
  requestKey: string;
  destinationThreadId: string;
  destinationTurnId?: string;
  state: "starting" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface SideThreadOperationRecord {
  operationId: string;
  attemptId?: string;
  kind: "fork" | "start" | "cancel" | "archive" | "purge" | "bring-back";
  requestKey: string;
  state: "pending" | "ambiguous" | "reconciling" | "completed" | "failed";
  threadId?: string;
  turnId?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SideThreadEventRecord {
  eventId: number;
  sideChatId: string;
  attemptId?: string;
  threadId?: string;
  turnId?: string;
  type: string;
  state?: string;
  reason?: string;
  createdAt: number;
}

export function installSideThreadSchema(database: DbAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS side_chats (
      side_chat_id       TEXT PRIMARY KEY,
      network_id         TEXT NOT NULL,
      node_id            TEXT NOT NULL,
      owner_user_id      TEXT NOT NULL,
      created_by_token_id TEXT NOT NULL,
      create_request_key TEXT NOT NULL,
      create_fingerprint TEXT NOT NULL,
      source_thread_id   TEXT NOT NULL,
      question_text      TEXT NOT NULL,
      boundary_kind      TEXT NOT NULL CHECK(boundary_kind IN ('through','before')),
      boundary_turn_id   TEXT NOT NULL,
      derived_thread_id  TEXT,
      state              TEXT NOT NULL,
      active_attempt_id  TEXT,
      lifecycle_operation TEXT,
      runtime            TEXT,
      runtime_version    TEXT,
      topology           TEXT,
      evidence_revision  TEXT,
      attachments_json   TEXT NOT NULL DEFAULT '[]',
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      archived_at        INTEGER,
      purged_at          INTEGER,
      UNIQUE(owner_user_id, create_request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_side_chats_owner_network
      ON side_chats(owner_user_id, network_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_side_chats_node
      ON side_chats(node_id, state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS side_chat_attempts (
      attempt_id         TEXT PRIMARY KEY,
      side_chat_id       TEXT NOT NULL,
      parent_attempt_id  TEXT,
      request_key        TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      prompt_hash        TEXT NOT NULL,
      attachments_json   TEXT NOT NULL DEFAULT '[]',
      thread_id          TEXT,
      turn_id            TEXT,
      cancel_requested_at INTEGER,
      state              TEXT NOT NULL,
      result_text        TEXT,
      error_text         TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      UNIQUE(side_chat_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_side_attempts_chat_time
      ON side_chat_attempts(side_chat_id, created_at, attempt_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_side_attempt_active
      ON side_chat_attempts(side_chat_id)
      WHERE state IN ('starting','running');

    CREATE TABLE IF NOT EXISTS side_chat_events (
      event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      side_chat_id  TEXT NOT NULL,
      attempt_id    TEXT,
      thread_id     TEXT,
      turn_id       TEXT,
      event_type    TEXT NOT NULL,
      state         TEXT,
      reason        TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_side_events_chat_id
      ON side_chat_events(side_chat_id, event_id);

    CREATE TABLE IF NOT EXISTS side_chat_operations (
      operation_id       TEXT PRIMARY KEY,
      side_chat_id       TEXT NOT NULL,
      attempt_id         TEXT,
      operation_kind     TEXT NOT NULL,
      request_key        TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      state              TEXT NOT NULL,
      thread_id          TEXT,
      turn_id            TEXT,
      error_code         TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      UNIQUE(side_chat_id, operation_kind, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_side_operations_chat_time
      ON side_chat_operations(side_chat_id, created_at, operation_id);

    CREATE TABLE IF NOT EXISTS side_chat_bring_backs (
      bring_back_id       TEXT PRIMARY KEY,
      side_chat_id        TEXT NOT NULL,
      attempt_id          TEXT NOT NULL,
      owner_user_id       TEXT NOT NULL,
      request_key         TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      destination_thread_id TEXT NOT NULL,
      destination_turn_id TEXT,
      state               TEXT NOT NULL,
      error_text          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      completed_at        INTEGER,
      UNIQUE(side_chat_id, request_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_side_bring_back_destination
      ON side_chat_bring_backs(side_chat_id, attempt_id, destination_thread_id);
  `);
  // Additive development migration for databases created by an earlier PR2
  // draft before cross-coordinator cancel claiming was introduced.
  try {
    database.exec(
      "ALTER TABLE side_chat_attempts ADD COLUMN cancel_requested_at INTEGER",
    );
  } catch (error: any) {
    if (!/duplicate column|already exists/i.test(error?.message ?? ""))
      throw error;
  }
  try {
    database.exec(
      "ALTER TABLE side_chat_attempts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
    );
  } catch (error: any) {
    if (!/duplicate column|already exists/i.test(error?.message ?? ""))
      throw error;
  }
  try {
    database.exec(
      "ALTER TABLE side_chat_bring_backs ADD COLUMN completed_at INTEGER",
    );
  } catch (error: any) {
    if (!/duplicate column|already exists/i.test(error?.message ?? ""))
      throw error;
  }
  try {
    database.exec("ALTER TABLE side_chats ADD COLUMN lifecycle_operation TEXT");
  } catch (error: any) {
    if (!/duplicate column|already exists/i.test(error?.message ?? ""))
      throw error;
  }
}

type SideChatRow = {
  side_chat_id: string;
  create_request_key: string;
  network_id: string;
  node_id: string;
  owner_user_id: string;
  source_thread_id: string;
  question_text: string;
  boundary_kind: "through" | "before";
  boundary_turn_id: string;
  derived_thread_id: string | null;
  state: SideThreadState;
  active_attempt_id: string | null;
  runtime: string | null;
  runtime_version: string | null;
  topology: string | null;
  evidence_revision: string | null;
  attachments_json: string;
  created_at: number;
  updated_at: number;
};
type AttemptRow = {
  attempt_id: string;
  request_key: string;
  parent_attempt_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  state: SideThreadAttemptState;
  result_text: string | null;
  error_text: string | null;
  attachments_json: string;
  created_at: number;
  updated_at: number;
};

export class SideThreadStore {
  constructor(readonly db: DbAdapter) {
    installSideThreadSchema(db);
  }

  getOwned(
    sideChatId: string,
    actor: SideThreadActor,
  ): SideThreadRecord | undefined {
    const row = this.db.get<SideChatRow>(
      "SELECT * FROM side_chats WHERE side_chat_id = ?1 AND owner_user_id = ?2",
      sideChatId,
      actor.userId,
    );
    if (!row) return undefined;
    if (actor.kind === "node" && actor.boundNodeId !== row.node_id)
      return undefined;
    if (actor.boundNetworkId && actor.boundNetworkId !== row.network_id)
      return undefined;
    return this.hydrate(row);
  }

  getByCreateKey(
    actor: SideThreadActor,
    requestKey: string,
  ): { record: SideThreadRecord; fingerprint: string } | undefined {
    const row = this.db.get<SideChatRow & { create_fingerprint: string }>(
      "SELECT * FROM side_chats WHERE owner_user_id = ?1 AND create_request_key = ?2",
      actor.userId,
      requestKey,
    );
    if (!row) return undefined;
    if (actor.kind === "node" && actor.boundNodeId !== row.node_id)
      return undefined;
    return { record: this.hydrate(row), fingerprint: row.create_fingerprint };
  }

  listOwned(
    actor: SideThreadActor,
    filters: { networkId?: string; nodeId?: string; limit?: number } = {},
  ): SideThreadRecord[] {
    let sql = "SELECT * FROM side_chats WHERE owner_user_id = ?1";
    const params: unknown[] = [actor.userId];
    const networkId = actor.boundNetworkId ?? filters.networkId;
    if (networkId) {
      params.push(networkId);
      sql += ` AND network_id = ?${params.length}`;
    }
    const nodeId = actor.kind === "node" ? actor.boundNodeId : filters.nodeId;
    if (nodeId) {
      params.push(nodeId);
      sql += ` AND node_id = ?${params.length}`;
    }
    params.push(Math.min(Math.max(filters.limit ?? 50, 1), 100));
    sql += ` ORDER BY updated_at DESC, side_chat_id DESC LIMIT ?${params.length}`;
    return this.db
      .all<SideChatRow>(sql, ...params)
      .map((row) => this.hydrate(row));
  }

  hydrate(row: SideChatRow): SideThreadRecord {
    const attempts = this.db
      .all<AttemptRow>(
        "SELECT attempt_id,request_key,parent_attempt_id,thread_id,turn_id,state,result_text,error_text,attachments_json,created_at,updated_at FROM side_chat_attempts WHERE side_chat_id = ?1 ORDER BY created_at,attempt_id",
        row.side_chat_id,
      )
      .map((a) => ({
        attemptId: a.attempt_id,
        requestKey: a.request_key,
        parentAttemptId: a.parent_attempt_id ?? undefined,
        threadId: a.thread_id ?? undefined,
        turnId: a.turn_id ?? undefined,
        state: a.state,
        result: a.result_text ?? undefined,
        error: a.error_text ?? undefined,
        attachments: parseAttachmentJson(a.attachments_json),
        createdAt: a.created_at,
        updatedAt: a.updated_at,
      }));
    let attachments: SideThreadAttachmentRef[] = [];
    try {
      attachments = JSON.parse(row.attachments_json);
    } catch {}
    const bringBacks = this.db
      .all<any>(
        "SELECT bring_back_id,attempt_id,request_key,destination_thread_id,destination_turn_id,state,created_at,updated_at,completed_at FROM side_chat_bring_backs WHERE side_chat_id=?1 ORDER BY created_at,bring_back_id",
        row.side_chat_id,
      )
      .map((b) => ({
        bringBackId: b.bring_back_id,
        attemptId: b.attempt_id,
        requestKey: b.request_key,
        destinationThreadId: b.destination_thread_id,
        destinationTurnId: b.destination_turn_id ?? undefined,
        state: b.state,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        completedAt: b.completed_at ?? undefined,
      }));
    const operations = this.db
      .all<any>(
        "SELECT operation_id,attempt_id,operation_kind,request_key,state,thread_id,turn_id,error_code,created_at,updated_at FROM side_chat_operations WHERE side_chat_id=?1 ORDER BY created_at,rowid",
        row.side_chat_id,
      )
      .map((op) => ({
        operationId: op.operation_id,
        attemptId: op.attempt_id ?? undefined,
        kind: op.operation_kind,
        requestKey: op.request_key,
        state: op.state,
        threadId: op.thread_id ?? undefined,
        turnId: op.turn_id ?? undefined,
        errorCode: op.error_code ?? undefined,
        createdAt: op.created_at,
        updatedAt: op.updated_at,
      }));
    return {
      sideChatId: row.side_chat_id,
      requestKey: row.create_request_key,
      networkId: row.network_id,
      nodeId: row.node_id,
      ownerUserId: row.owner_user_id,
      sourceThreadId: row.source_thread_id,
      question: row.question_text,
      boundary: {
        kind: row.boundary_kind,
        turnId: row.boundary_turn_id,
      } as SideThreadBoundary,
      threadId: row.derived_thread_id ?? undefined,
      state: row.state,
      activeAttemptId: row.active_attempt_id ?? undefined,
      runtime: row.runtime ?? undefined,
      runtimeVersion: row.runtime_version ?? undefined,
      topology: row.topology ?? undefined,
      evidenceRevision: row.evidence_revision ?? undefined,
      attachments,
      attempts,
      bringBacks,
      operations,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  events(sideChatId: string, after = 0): SideThreadEventRecord[] {
    return this.db
      .all<any>(
        "SELECT event_id,side_chat_id,attempt_id,thread_id,turn_id,event_type,state,reason,created_at FROM side_chat_events WHERE side_chat_id = ?1 AND event_id > ?2 ORDER BY event_id LIMIT 500",
        sideChatId,
        after,
      )
      .map((e) => ({
        eventId: e.event_id,
        sideChatId: e.side_chat_id,
        attemptId: e.attempt_id ?? undefined,
        threadId: e.thread_id ?? undefined,
        turnId: e.turn_id ?? undefined,
        type: e.event_type,
        state: e.state ?? undefined,
        reason: e.reason ?? undefined,
        createdAt: e.created_at,
      }));
  }
}

type CreateInput = {
  requestKey: string;
  networkId: string;
  nodeId: string;
  sourceThreadId: string;
  boundary: SideThreadBoundary;
  prompt: string;
  attachments?: SideThreadAttachmentRef[];
};

export class SideThreadCoordinator {
  private readonly emitter = new EventEmitter();
  private readonly unsubscribe: () => void;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: SideThreadStore,
    readonly port: SideThreadExecutionPort,
    private readonly opts: {
      enabled: boolean;
      authorizeNode: (
        actor: SideThreadActor,
        networkId: string,
        nodeId: string,
      ) => boolean;
      authorizeAttachment?: (
        actor: SideThreadActor,
        networkId: string,
        ref: SideThreadAttachmentRef,
      ) => boolean;
      now?: () => number;
      id?: () => string;
    },
  ) {
    this.unsubscribe = port.subscribe((event) => {
      void this.acceptRuntimeEvent(event);
    });
  }

  close(): void {
    this.unsubscribe();
    this.emitter.removeAllListeners();
  }
  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private id(prefix: string): string {
    return `${prefix}_${(this.opts.id ?? randomUUID)().replace(/-/g, "")}`;
  }

  private assertEnabled(): void {
    if (!this.opts.enabled)
      throw new SideThreadError(
        "SIDE_THREAD_DISABLED",
        "SideThread API is disabled",
        404,
      );
  }
  private assertActor(actor: SideThreadActor): void {
    requireIdentity(actor.userId, "actor.userId");
    requireIdentity(actor.tokenId, "actor.tokenId");
  }
  private async assertCapability(
    nodeId: string,
    boundary?: SideThreadBoundary,
  ): Promise<SideThreadCapability> {
    const cap = await this.port.capability(nodeId);
    if (!cap.supported)
      throw new SideThreadError(
        "SIDE_THREAD_UNSUPPORTED",
        capabilityReason(cap.reason),
        501,
      );
    if (cap.mode !== "native-exact-fork")
      throw new SideThreadError(
        "SIDE_THREAD_UNSUPPORTED",
        "verified native exact-fork mode unavailable",
        501,
      );
    if (boundary && !cap.exactBoundary?.[boundary.kind]) {
      throw new SideThreadError(
        "SIDE_THREAD_UNSUPPORTED",
        `exact '${boundary.kind}' boundary unavailable`,
        501,
      );
    }
    return cap;
  }

  async create(
    actor: SideThreadActor,
    input: CreateInput,
  ): Promise<SideThreadRecord> {
    this.assertEnabled();
    this.assertActor(actor);
    validateCreateInput(input);
    if (!this.opts.authorizeNode(actor, input.networkId, input.nodeId)) {
      throw new SideThreadError("SIDE_THREAD_NOT_FOUND", "node not found", 404);
    }
    const attachments = normalizeAttachments(input.attachments);
    for (const ref of attachments) {
      if (!this.opts.authorizeAttachment?.(actor, input.networkId, ref)) {
        throw new SideThreadError(
          "SIDE_THREAD_ATTACHMENT_NOT_FOUND",
          "attachment not found",
          404,
        );
      }
    }
    const fingerprint = hashJson([
      input.networkId,
      input.nodeId,
      input.sourceThreadId,
      input.boundary,
      input.prompt,
      attachments,
    ]);
    const existing = this.store.getByCreateKey(actor, input.requestKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw conflict("idempotency key reused with different create payload");
      return existing.record;
    }
    return this.singleFlight(
      `create:${actor.userId}:${input.requestKey}`,
      async () => {
        const replay = this.store.getByCreateKey(actor, input.requestKey);
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw conflict(
              "idempotency key reused with different create payload",
            );
          return replay.record;
        }
        const capability = await this.assertCapability(
          input.nodeId,
          input.boundary,
        );
        const sideChatId = this.id("sch");
        const attemptId = this.id("sat");
        const forkOperationId = stableOperationId(
          sideChatId,
          "fork",
          input.requestKey,
        );
        const now = this.now();
        try {
          this.store.db.transaction(() => {
            this.store.db.run(
              `INSERT INTO side_chats (side_chat_id,network_id,node_id,owner_user_id,created_by_token_id,create_request_key,create_fingerprint,source_thread_id,question_text,boundary_kind,boundary_turn_id,state,active_attempt_id,runtime,runtime_version,topology,evidence_revision,attachments_json,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'creating',?12,?13,?14,?15,?16,?17,?18,?18)`,
              [
                sideChatId,
                input.networkId,
                input.nodeId,
                actor.userId,
                actor.tokenId,
                input.requestKey,
                fingerprint,
                input.sourceThreadId,
                input.prompt,
                input.boundary.kind,
                input.boundary.turnId,
                attemptId,
                capability.runtime ?? null,
                capability.runtimeVersion ?? null,
                capability.topology ?? null,
                capability.evidenceRevision ?? null,
                JSON.stringify(attachments),
                now,
              ],
            );
            this.store.db.run(
              `INSERT INTO side_chat_attempts (attempt_id,side_chat_id,request_key,request_fingerprint,prompt_hash,attachments_json,state,created_at,updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,'starting',?7,?7)`,
              [
                attemptId,
                sideChatId,
                input.requestKey,
                fingerprint,
                hashText(input.prompt),
                JSON.stringify(attachments),
                now,
              ],
            );
            this.insertOperation({
              operationId: forkOperationId,
              sideChatId,
              attemptId,
              kind: "fork",
              requestKey: input.requestKey,
              fingerprint,
              at: now,
            });
            this.emitStored(
              sideChatId,
              attemptId,
              undefined,
              undefined,
              "side_chat.created",
              "creating",
              undefined,
              now,
            );
          });
        } catch (error) {
          const winner = this.store.getByCreateKey(actor, input.requestKey);
          if (winner) {
            if (winner.fingerprint !== fingerprint)
              throw conflict(
                "idempotency key reused with different create payload",
              );
            return winner.record;
          }
          throw error;
        }
        let activeOperationId = forkOperationId;
        try {
          const forked = await this.port.fork({
            operationId: forkOperationId,
            requestKey: input.requestKey,
            sideChatId,
            nodeId: input.nodeId,
            sourceThreadId: input.sourceThreadId,
            boundary: input.boundary,
          });
          requireRuntimeIdentity(forked.threadId, "threadId");
          if (forked.threadId === input.sourceThreadId)
            throw runtimeProtocol(
              "runtime returned source thread as side thread",
            );
          this.store.db.transaction(() => {
            const t = this.now();
            this.store.db.run(
              "UPDATE side_chats SET derived_thread_id=?1,updated_at=?2 WHERE side_chat_id=?3 AND state='creating'",
              [forked.threadId, t, sideChatId],
            );
            this.store.db.run(
              "UPDATE side_chat_attempts SET thread_id=?1,updated_at=?2 WHERE attempt_id=?3 AND state='starting'",
              [forked.threadId, t, attemptId],
            );
            this.settleOperation(forkOperationId, "completed", {
              threadId: forked.threadId,
            });
          });
          const startOperationId = stableOperationId(
            sideChatId,
            "start",
            input.requestKey,
          );
          activeOperationId = startOperationId;
          this.insertOperation({
            operationId: startOperationId,
            sideChatId,
            attemptId,
            kind: "start",
            requestKey: input.requestKey,
            fingerprint,
            threadId: forked.threadId,
            at: this.now(),
          });
          const started = await this.port.start({
            operationId: startOperationId,
            requestKey: input.requestKey,
            sideChatId,
            attemptId,
            nodeId: input.nodeId,
            threadId: forked.threadId,
            prompt: input.prompt,
            attachments,
          });
          requireRuntimeIdentity(started.turnId, "turnId");
          this.store.db.transaction(() => {
            const attempt = this.store.db.get<any>(
              "SELECT state,turn_id FROM side_chat_attempts WHERE attempt_id=?1",
              attemptId,
            );
            if (!attempt) throw conflict("attempt disappeared during start");
            if (attempt.turn_id && attempt.turn_id !== started.turnId)
              throw runtimeProtocol(
                "runtime turn identity changed during start",
              );
            this.settleOperation(startOperationId, "completed", {
              threadId: forked.threadId,
              turnId: started.turnId,
            });
            if (attempt.state === "starting") {
              const t = this.now();
              this.store.db.run(
                "UPDATE side_chat_attempts SET state='running',turn_id=?1,updated_at=?2 WHERE attempt_id=?3 AND state='starting'",
                [started.turnId, t, attemptId],
              );
              this.store.db.run(
                "UPDATE side_chats SET state='running',derived_thread_id=?1,updated_at=?2 WHERE side_chat_id=?3 AND active_attempt_id=?4",
                [forked.threadId, t, sideChatId, attemptId],
              );
              this.emitStored(
                sideChatId,
                attemptId,
                forked.threadId,
                started.turnId,
                "attempt.running",
                "running",
                undefined,
                t,
              );
            }
          });
        } catch (error) {
          if (isAmbiguousRuntimeError(error)) {
            if (this.operationState(activeOperationId) === "completed")
              return this.mustOwned(sideChatId, actor);
            this.markAmbiguous(sideChatId, attemptId, activeOperationId, error);
            throw ambiguousError(activeOperationId, sideChatId, attemptId);
          }
          this.settleOperation(activeOperationId, "failed", {
            errorCode: auditErrorReason(error),
          });
          this.failStarting(sideChatId, attemptId, error);
          throw normalizePortError(error);
        }
        return this.mustOwned(sideChatId, actor);
      },
    );
  }

  get(actor: SideThreadActor, sideChatId: string): SideThreadRecord {
    this.assertEnabled();
    this.assertActor(actor);
    requireIdentity(sideChatId, "sideChatId");
    return this.mustOwned(sideChatId, actor);
  }

  list(
    actor: SideThreadActor,
    filters: { networkId?: string; nodeId?: string; limit?: number } = {},
  ): SideThreadRecord[] {
    this.assertEnabled();
    this.assertActor(actor);
    if (filters.networkId) requireIdentity(filters.networkId, "networkId");
    if (filters.nodeId) requireIdentity(filters.nodeId, "nodeId");
    return this.store
      .listOwned(actor, filters)
      .filter((record) =>
        this.opts.authorizeNode(actor, record.networkId, record.nodeId),
      );
  }

  isEnabled(): boolean {
    return this.opts.enabled;
  }

  async capability(
    actor: SideThreadActor,
    networkId: string,
    nodeId: string,
    boundary: SideThreadBoundary,
  ): Promise<SideThreadCapability> {
    this.assertEnabled();
    this.assertActor(actor);
    requireIdentity(networkId, "networkId");
    requireIdentity(nodeId, "nodeId");
    requireIdentity(boundary.turnId, "boundary.turnId");
    if (!this.opts.authorizeNode(actor, networkId, nodeId))
      throw new SideThreadError("SIDE_THREAD_NOT_FOUND", "node not found", 404);
    const capability = await this.port.capability(nodeId);
    if (!capability.supported)
      return {
        supported: false,
        reason: capabilityReasonCode(capability.reason),
      };
    if (capability.mode !== "native-exact-fork")
      return { supported: false, reason: "native-exact-fork-unavailable" };
    if (!capability.exactBoundary?.[boundary.kind])
      return { supported: false, reason: `exact-${boundary.kind}-unavailable` };
    return capability;
  }

  async cancel(
    actor: SideThreadActor,
    sideChatId: string,
  ): Promise<SideThreadRecord> {
    this.assertEnabled();
    return this.singleFlight(`cancel:${sideChatId}`, async () => {
      const record = this.mustOwned(sideChatId, actor);
      const attempt = record.attempts.find(
        (a) => a.attemptId === record.activeAttemptId,
      );
      if (
        !attempt?.threadId ||
        !attempt.turnId ||
        !["running", "ambiguous", "reconciling"].includes(attempt.state)
      )
        throw conflict("side chat has no cancellable attempt");
      await this.assertCapability(record.nodeId);
      const operationRequestKey = `cancel:${attempt.attemptId}`;
      const prepared = this.prepareStableOperation({
        sideChatId,
        attemptId: attempt.attemptId,
        kind: "cancel",
        requestKey: operationRequestKey,
        fingerprint: hashJson([
          sideChatId,
          attempt.attemptId,
          attempt.threadId,
          attempt.turnId,
        ]),
        threadId: attempt.threadId,
        turnId: attempt.turnId,
      });
      if (prepared.state === "completed") return record;
      if (prepared.state === "ambiguous" || prepared.state === "reconciling")
        throw ambiguousError(
          prepared.operationId,
          sideChatId,
          attempt.attemptId,
        );
      // A second coordinator observing the durable pending claim must never
      // issue another RPC. Returning its current owner projection is an
      // honest in-progress replay; ambiguous is handled above and is typed.
      if (!prepared.callable) return this.mustOwned(sideChatId, actor);
      const claimedAt = this.now();
      const claim = this.store.db.run(
        "UPDATE side_chat_attempts SET cancel_requested_at=?1,updated_at=?1 WHERE attempt_id=?2 AND state='running' AND thread_id=?3 AND turn_id=?4 AND cancel_requested_at IS NULL",
        [claimedAt, attempt.attemptId, attempt.threadId, attempt.turnId],
      );
      if (claim.changes === 0) {
        this.markAmbiguous(
          sideChatId,
          attempt.attemptId,
          prepared.operationId,
          { code: "SIDE_THREAD_RESPONSE_LOST" },
        );
        throw ambiguousError(
          prepared.operationId,
          sideChatId,
          attempt.attemptId,
        );
      }
      try {
        await this.port.cancel({
          operationId: prepared.operationId,
          sideChatId,
          attemptId: attempt.attemptId,
          nodeId: record.nodeId,
          threadId: attempt.threadId,
          turnId: attempt.turnId,
        });
      } catch (error) {
        if (isAmbiguousRuntimeError(error)) {
          this.markAmbiguous(
            sideChatId,
            attempt.attemptId,
            prepared.operationId,
            error,
          );
          throw ambiguousError(
            prepared.operationId,
            sideChatId,
            attempt.attemptId,
          );
        }
        this.settleOperation(prepared.operationId, "failed", {
          errorCode: auditErrorReason(error),
        });
        this.store.db.run(
          "UPDATE side_chat_attempts SET cancel_requested_at=NULL,updated_at=?1 WHERE attempt_id=?2 AND state='running' AND thread_id=?3 AND turn_id=?4",
          [this.now(), attempt.attemptId, attempt.threadId, attempt.turnId],
        );
        throw normalizePortError(error);
      }
      this.store.db.transaction(() => {
        const t = this.now();
        const changed = this.store.db.run(
          "UPDATE side_chat_attempts SET state='cancelled',updated_at=?1 WHERE attempt_id=?2 AND state='running' AND thread_id=?3 AND turn_id=?4",
          [t, attempt.attemptId, attempt.threadId, attempt.turnId],
        );
        if (changed.changes > 0) {
          this.store.db.run(
            "UPDATE side_chats SET state='cancelled',active_attempt_id=NULL,updated_at=?1 WHERE side_chat_id=?2 AND active_attempt_id=?3",
            [t, sideChatId, attempt.attemptId],
          );
          this.emitStored(
            sideChatId,
            attempt.attemptId,
            attempt.threadId,
            attempt.turnId,
            "attempt.cancelled",
            "cancelled",
            undefined,
            t,
          );
        }
        this.settleOperation(prepared.operationId, "completed", {
          threadId: attempt.threadId,
          turnId: attempt.turnId,
        });
      });
      return this.mustOwned(sideChatId, actor);
    });
  }

  async retry(
    actor: SideThreadActor,
    sideChatId: string,
    input: {
      requestKey: string;
      prompt: string;
      attachments?: SideThreadAttachmentRef[];
    },
  ): Promise<SideThreadRecord> {
    this.assertEnabled();
    requireKey(input.requestKey);
    requirePrompt(input.prompt);
    return this.singleFlight(
      `retry:${sideChatId}:${input.requestKey}`,
      async () => {
        const record = this.mustOwned(sideChatId, actor);
        if (!record.threadId) throw conflict("side chat has no derived thread");
        const attachments = normalizeAttachments(
          input.attachments ?? record.attachments,
        );
        for (const ref of attachments)
          if (!this.opts.authorizeAttachment?.(actor, record.networkId, ref))
            throw new SideThreadError(
              "SIDE_THREAD_ATTACHMENT_NOT_FOUND",
              "attachment not found",
              404,
            );
        const fingerprint = hashJson([sideChatId, input.prompt, attachments]);
        const old = this.store.db.get<any>(
          "SELECT attempt_id,request_fingerprint FROM side_chat_attempts WHERE side_chat_id=?1 AND request_key=?2",
          sideChatId,
          input.requestKey,
        );
        if (old) {
          if (old.request_fingerprint !== fingerprint)
            throw conflict(
              "idempotency key reused with different retry payload",
            );
          return this.mustOwned(sideChatId, actor);
        }
        if (record.activeAttemptId)
          throw conflict("side chat already has an active attempt");
        if (record.state === "archived" || record.state === "purged")
          throw conflict(`cannot retry ${record.state} side chat`);
        await this.assertCapability(record.nodeId);
        const parent = record.attempts.at(-1);
        if (!parent) throw conflict("side chat has no prior attempt");
        const attemptId = this.id("sat"),
          startOperationId = stableOperationId(
            sideChatId,
            "start",
            input.requestKey,
          ),
          t = this.now();
        try {
          this.store.db.transaction(() => {
            this.store.db.run(
              "INSERT INTO side_chat_attempts (attempt_id,side_chat_id,parent_attempt_id,request_key,request_fingerprint,prompt_hash,attachments_json,thread_id,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'starting',?9,?9)",
              [
                attemptId,
                sideChatId,
                parent.attemptId,
                input.requestKey,
                fingerprint,
                hashText(input.prompt),
                JSON.stringify(attachments),
                record.threadId,
                t,
              ],
            );
            this.insertOperation({
              operationId: startOperationId,
              sideChatId,
              attemptId,
              kind: "start",
              requestKey: input.requestKey,
              fingerprint,
              threadId: record.threadId,
              at: t,
            });
            this.store.db.run(
              "UPDATE side_chats SET state='running',active_attempt_id=?1,updated_at=?2 WHERE side_chat_id=?3 AND active_attempt_id IS NULL",
              [attemptId, t, sideChatId],
            );
            this.emitStored(
              sideChatId,
              attemptId,
              record.threadId,
              undefined,
              "attempt.retrying",
              "starting",
              undefined,
              t,
            );
          });
        } catch (error) {
          const winner = this.store.db.get<any>(
            "SELECT request_fingerprint FROM side_chat_attempts WHERE side_chat_id=?1 AND request_key=?2",
            sideChatId,
            input.requestKey,
          );
          if (winner) {
            if (winner.request_fingerprint !== fingerprint)
              throw conflict(
                "idempotency key reused with different retry payload",
              );
            return this.mustOwned(sideChatId, actor);
          }
          const active = this.store.db.get<{ attempt_id: string }>(
            "SELECT attempt_id FROM side_chat_attempts WHERE side_chat_id=?1 AND state IN ('starting','running') LIMIT 1",
            sideChatId,
          );
          if (active) throw conflict("side chat already has an active attempt");
          throw error;
        }
        try {
          const started = await this.port.start({
            operationId: startOperationId,
            requestKey: input.requestKey,
            sideChatId,
            attemptId,
            nodeId: record.nodeId,
            threadId: record.threadId,
            prompt: input.prompt,
            attachments,
          });
          requireRuntimeIdentity(started.turnId, "turnId");
          this.store.db.transaction(() => {
            const now = this.now();
            const attempt = this.store.db.get<any>(
              "SELECT state,turn_id FROM side_chat_attempts WHERE attempt_id=?1",
              attemptId,
            );
            if (attempt?.turn_id && attempt.turn_id !== started.turnId)
              throw runtimeProtocol(
                "runtime turn identity changed during retry",
              );
            this.settleOperation(startOperationId, "completed", {
              threadId: record.threadId,
              turnId: started.turnId,
            });
            if (attempt?.state === "starting") {
              this.store.db.run(
                "UPDATE side_chat_attempts SET state='running',turn_id=?1,updated_at=?2 WHERE attempt_id=?3",
                [started.turnId, now, attemptId],
              );
              this.emitStored(
                sideChatId,
                attemptId,
                record.threadId,
                started.turnId,
                "attempt.running",
                "running",
                undefined,
                now,
              );
            }
          });
        } catch (error) {
          if (isAmbiguousRuntimeError(error)) {
            if (this.operationState(startOperationId) === "completed")
              return this.mustOwned(sideChatId, actor);
            this.markAmbiguous(sideChatId, attemptId, startOperationId, error);
            throw ambiguousError(startOperationId, sideChatId, attemptId);
          }
          this.settleOperation(startOperationId, "failed", {
            errorCode: auditErrorReason(error),
          });
          this.failStarting(sideChatId, attemptId, error);
          throw normalizePortError(error);
        }
        return this.mustOwned(sideChatId, actor);
      },
    );
  }

  async archive(
    actor: SideThreadActor,
    sideChatId: string,
  ): Promise<SideThreadRecord> {
    return this.lifecycle(actor, sideChatId, "archive");
  }
  async purge(
    actor: SideThreadActor,
    sideChatId: string,
  ): Promise<SideThreadRecord> {
    return this.lifecycle(actor, sideChatId, "purge");
  }
  private async lifecycle(
    actor: SideThreadActor,
    sideChatId: string,
    action: "archive" | "purge",
  ): Promise<SideThreadRecord> {
    this.assertEnabled();
    return this.singleFlight(`${action}:${sideChatId}`, async () => {
      const r = this.mustOwned(sideChatId, actor);
      if (r.activeAttemptId)
        throw conflict(`cannot ${action} a running side chat`);
      if (!r.threadId) throw conflict("side chat has no derived thread");
      if (r.state === "purged") return r;
      if (action === "archive" && r.state === "archived") return r;
      await this.assertCapability(r.nodeId);
      const operationRequestKey = `${action}:${sideChatId}`;
      const prepared = this.prepareStableOperation({
        sideChatId,
        kind: action,
        requestKey: operationRequestKey,
        fingerprint: hashJson([action, sideChatId, r.nodeId, r.threadId]),
        threadId: r.threadId,
      });
      if (prepared.state === "completed") return r;
      if (prepared.state === "ambiguous" || prepared.state === "reconciling")
        throw ambiguousError(prepared.operationId, sideChatId);
      if (!prepared.callable)
        throw conflict("side chat lifecycle operation already in progress");
      const claim = this.store.db.run(
        "UPDATE side_chats SET lifecycle_operation=?1,updated_at=?2 WHERE side_chat_id=?3 AND active_attempt_id IS NULL AND lifecycle_operation IS NULL",
        [action, this.now(), sideChatId],
      );
      if (claim.changes === 0) {
        const current = this.mustOwned(sideChatId, actor);
        if (current.state === "purged") return current;
        if (action === "archive" && current.state === "archived")
          return current;
        this.markAmbiguous(sideChatId, undefined, prepared.operationId, {
          code: "SIDE_THREAD_RESPONSE_LOST",
        });
        throw ambiguousError(prepared.operationId, sideChatId);
      }
      try {
        if (action === "archive")
          await this.port.archive({
            operationId: prepared.operationId,
            sideChatId,
            nodeId: r.nodeId,
            threadId: r.threadId,
          });
        else
          await this.port.purge({
            operationId: prepared.operationId,
            sideChatId,
            nodeId: r.nodeId,
            threadId: r.threadId,
          });
      } catch (error) {
        if (isAmbiguousRuntimeError(error)) {
          this.markAmbiguous(
            sideChatId,
            undefined,
            prepared.operationId,
            error,
          );
          throw ambiguousError(prepared.operationId, sideChatId);
        }
        this.settleOperation(prepared.operationId, "failed", {
          errorCode: auditErrorReason(error),
        });
        this.store.db.run(
          "UPDATE side_chats SET lifecycle_operation=NULL,updated_at=?1 WHERE side_chat_id=?2 AND lifecycle_operation=?3",
          [this.now(), sideChatId, action],
        );
        throw normalizePortError(error);
      }
      const state = action === "archive" ? "archived" : "purged",
        t = this.now();
      this.store.db.transaction(() => {
        if (action === "purge") {
          this.store.db.run(
            "UPDATE side_chats SET state='purged',question_text='',attachments_json='[]',lifecycle_operation=NULL,updated_at=?1,purged_at=?1 WHERE side_chat_id=?2 AND active_attempt_id IS NULL AND lifecycle_operation='purge'",
            [t, sideChatId],
          );
          this.store.db.run(
            "UPDATE side_chat_attempts SET result_text=NULL,error_text=NULL,updated_at=?1 WHERE side_chat_id=?2",
            [t, sideChatId],
          );
        } else {
          this.store.db.run(
            "UPDATE side_chats SET state='archived',lifecycle_operation=NULL,updated_at=?1,archived_at=?1 WHERE side_chat_id=?2 AND active_attempt_id IS NULL AND lifecycle_operation='archive'",
            [t, sideChatId],
          );
        }
        this.settleOperation(prepared.operationId, "completed", {
          threadId: r.threadId,
        });
        this.emitStored(
          sideChatId,
          undefined,
          r.threadId,
          undefined,
          `side_chat.${state}`,
          state,
          undefined,
          t,
        );
      });
      return this.mustOwned(sideChatId, actor);
    });
  }

  async bringBack(
    actor: SideThreadActor,
    sideChatId: string,
    input: {
      requestKey: string;
      destinationThreadId: string;
      attemptId?: string;
    },
  ): Promise<{ bringBackId: string; destinationTurnId: string }> {
    this.assertEnabled();
    requireKey(input.requestKey);
    requireIdentity(input.destinationThreadId, "destinationThreadId");
    return this.singleFlight(
      `bring-back:${sideChatId}:${input.requestKey}`,
      async () => {
        const r = this.mustOwned(sideChatId, actor);
        if (r.state === "purged")
          throw conflict("cannot bring back a purged side chat");
        if (input.destinationThreadId !== r.sourceThreadId)
          throw conflict(
            "bring-back destination must be the original source thread",
          );
        const attempt = input.attemptId
          ? r.attempts.find((a) => a.attemptId === input.attemptId)
          : [...r.attempts].reverse().find((a) => a.state === "completed");
        if (
          !attempt ||
          attempt.state !== "completed" ||
          !attempt.result ||
          !attempt.threadId ||
          !attempt.turnId
        )
          throw conflict("bring-back requires a completed owned attempt");
        const fp = hashJson([
          sideChatId,
          attempt.attemptId,
          input.destinationThreadId,
        ]);
        const old = this.store.db.get<any>(
          "SELECT bring_back_id,destination_turn_id,request_fingerprint,state FROM side_chat_bring_backs WHERE side_chat_id=?1 AND request_key=?2",
          sideChatId,
          input.requestKey,
        );
        if (old) {
          if (old.request_fingerprint !== fp)
            throw conflict(
              "idempotency key reused with different bring-back payload",
            );
          if (old.state !== "completed" || !old.destination_turn_id) {
            const operation = this.store.db.get<{
              operation_id: string;
              state: string;
            }>(
              "SELECT operation_id,state FROM side_chat_operations WHERE side_chat_id=?1 AND operation_kind='bring-back' AND request_key=?2",
              sideChatId,
              input.requestKey,
            );
            if (
              operation &&
              (operation.state === "ambiguous" ||
                operation.state === "reconciling")
            )
              throw ambiguousError(
                operation.operation_id,
                sideChatId,
                attempt.attemptId,
              );
            throw conflict("bring-back is already in progress or failed");
          }
          return {
            bringBackId: old.bring_back_id,
            destinationTurnId: old.destination_turn_id,
          };
        }
        const priorDestination = this.store.db.get<any>(
          "SELECT bring_back_id,destination_turn_id,state FROM side_chat_bring_backs WHERE side_chat_id=?1 AND attempt_id=?2 AND destination_thread_id=?3",
          sideChatId,
          attempt.attemptId,
          input.destinationThreadId,
        );
        if (priorDestination) {
          if (
            priorDestination.state === "completed" &&
            priorDestination.destination_turn_id
          )
            return {
              bringBackId: priorDestination.bring_back_id,
              destinationTurnId: priorDestination.destination_turn_id,
            };
          throw conflict(
            "bring-back for this attempt is already in progress or failed",
          );
        }
        await this.assertCapability(r.nodeId);
        const prepared = this.prepareStableOperation({
          sideChatId,
          attemptId: attempt.attemptId,
          kind: "bring-back",
          requestKey: input.requestKey,
          fingerprint: fp,
          threadId: attempt.threadId,
          turnId: attempt.turnId,
        });
        if (prepared.state === "completed") {
          const completed = this.store.db.get<any>(
            "SELECT bring_back_id,destination_turn_id FROM side_chat_bring_backs WHERE side_chat_id=?1 AND request_key=?2 AND state='completed'",
            sideChatId,
            input.requestKey,
          );
          if (completed?.destination_turn_id)
            return {
              bringBackId: completed.bring_back_id,
              destinationTurnId: completed.destination_turn_id,
            };
        }
        if (prepared.state === "ambiguous" || prepared.state === "reconciling")
          throw ambiguousError(
            prepared.operationId,
            sideChatId,
            attempt.attemptId,
          );
        if (!prepared.callable)
          throw conflict("bring-back operation is already in progress");
        const bringBackId = this.id("sbb"),
          t = this.now();
        try {
          this.store.db.run(
            "INSERT INTO side_chat_bring_backs (bring_back_id,side_chat_id,attempt_id,owner_user_id,request_key,request_fingerprint,destination_thread_id,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'starting',?8,?8)",
            [
              bringBackId,
              sideChatId,
              attempt.attemptId,
              actor.userId,
              input.requestKey,
              fp,
              input.destinationThreadId,
              t,
            ],
          );
        } catch (error) {
          const winner = this.store.db.get<any>(
            "SELECT bring_back_id,destination_turn_id,state,request_key,request_fingerprint FROM side_chat_bring_backs WHERE side_chat_id=?1 AND (request_key=?2 OR (attempt_id=?3 AND destination_thread_id=?4)) LIMIT 1",
            sideChatId,
            input.requestKey,
            attempt.attemptId,
            input.destinationThreadId,
          );
          if (
            winner?.request_key === input.requestKey &&
            winner.request_fingerprint !== fp
          )
            throw conflict(
              "idempotency key reused with different bring-back payload",
            );
          if (winner?.state === "completed" && winner.destination_turn_id)
            return {
              bringBackId: winner.bring_back_id,
              destinationTurnId: winner.destination_turn_id,
            };
          if (winner)
            throw conflict(
              "bring-back for this attempt is already in progress or failed",
            );
          throw error;
        }
        try {
          const out = await this.port.bringBack({
            operationId: prepared.operationId,
            sideChatId,
            attemptId: attempt.attemptId,
            nodeId: r.nodeId,
            sourceThreadId: attempt.threadId,
            sourceTurnId: attempt.turnId,
            destinationThreadId: input.destinationThreadId,
            requestKey: input.requestKey,
            text: attempt.result,
          });
          requireRuntimeIdentity(out.destinationTurnId, "destinationTurnId");
          const now = this.now();
          this.store.db.transaction(() => {
            this.store.db.run(
              "UPDATE side_chat_bring_backs SET state='completed',destination_turn_id=?1,updated_at=?2,completed_at=?2 WHERE bring_back_id=?3 AND state='starting'",
              [out.destinationTurnId, now, bringBackId],
            );
            this.settleOperation(prepared.operationId, "completed", {
              threadId: input.destinationThreadId,
              turnId: out.destinationTurnId,
            });
            this.emitStored(
              sideChatId,
              attempt.attemptId,
              attempt.threadId,
              attempt.turnId,
              "side_chat.brought_back",
              "completed",
              undefined,
              now,
            );
          });
          return { bringBackId, destinationTurnId: out.destinationTurnId };
        } catch (error) {
          const operation = this.store.db.get<{ operation_id: string }>(
            "SELECT operation_id FROM side_chat_operations WHERE side_chat_id=?1 AND operation_kind='bring-back' AND request_key=?2",
            sideChatId,
            input.requestKey,
          );
          if (operation && isAmbiguousRuntimeError(error)) {
            this.markAmbiguous(
              sideChatId,
              attempt.attemptId,
              operation.operation_id,
              error,
            );
            throw ambiguousError(
              operation.operation_id,
              sideChatId,
              attempt.attemptId,
            );
          }
          if (operation)
            this.settleOperation(operation.operation_id, "failed", {
              errorCode: auditErrorReason(error),
            });
          this.store.db.run(
            "UPDATE side_chat_bring_backs SET state='failed',error_text=?1,updated_at=?2 WHERE bring_back_id=?3 AND state='starting'",
            [
              safeReason(
                error instanceof Error ? error.message : String(error),
              ),
              this.now(),
              bringBackId,
            ],
          );
          throw normalizePortError(error);
        }
      },
    );
  }

  listEvents(
    actor: SideThreadActor,
    sideChatId: string,
    after = 0,
  ): SideThreadEventRecord[] {
    this.mustOwned(sideChatId, actor);
    return this.store.events(sideChatId, after);
  }
  subscribe(
    sideChatId: string,
    listener: (event: SideThreadEventRecord) => void,
  ): () => void {
    const key = `side:${sideChatId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  private insertOperation(input: {
    operationId: string;
    sideChatId: string;
    attemptId?: string;
    kind: SideThreadOperationRecord["kind"];
    requestKey: string;
    fingerprint: string;
    threadId?: string;
    turnId?: string;
    at: number;
  }): void {
    this.store.db.run(
      "INSERT INTO side_chat_operations (operation_id,side_chat_id,attempt_id,operation_kind,request_key,request_fingerprint,state,thread_id,turn_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8,?9,?9)",
      [
        input.operationId,
        input.sideChatId,
        input.attemptId ?? null,
        input.kind,
        input.requestKey,
        input.fingerprint,
        input.threadId ?? null,
        input.turnId ?? null,
        input.at,
      ],
    );
  }

  private prepareStableOperation(input: {
    sideChatId: string;
    attemptId?: string;
    kind: SideThreadOperationRecord["kind"];
    requestKey: string;
    fingerprint: string;
    threadId?: string;
    turnId?: string;
  }): {
    operationId: string;
    state: SideThreadOperationRecord["state"];
    callable: boolean;
  } {
    const operationId = stableOperationId(
      input.sideChatId,
      input.kind,
      input.requestKey,
    );
    const existing = this.store.db.get<any>(
      "SELECT operation_id,request_fingerprint,state FROM side_chat_operations WHERE side_chat_id=?1 AND operation_kind=?2 AND request_key=?3",
      input.sideChatId,
      input.kind,
      input.requestKey,
    );
    if (existing) {
      if (existing.request_fingerprint !== input.fingerprint)
        throw conflict("operation request key reused with different payload");
      if (existing.state === "failed") {
        this.store.db.run(
          "UPDATE side_chat_operations SET state='pending',error_code=NULL,updated_at=?1 WHERE operation_id=?2 AND state='failed'",
          [this.now(), existing.operation_id],
        );
        return {
          operationId: existing.operation_id,
          state: "pending",
          callable: true,
        };
      }
      return {
        operationId: existing.operation_id,
        state: existing.state,
        callable: false,
      };
    }
    this.insertOperation({
      operationId,
      sideChatId: input.sideChatId,
      attemptId: input.attemptId,
      kind: input.kind,
      requestKey: input.requestKey,
      fingerprint: input.fingerprint,
      threadId: input.threadId,
      turnId: input.turnId,
      at: this.now(),
    });
    return { operationId, state: "pending", callable: true };
  }

  private settleOperation(
    operationId: string,
    state: "completed" | "failed",
    fields: { threadId?: string; turnId?: string; errorCode?: string } = {},
  ): void {
    this.store.db.run(
      "UPDATE side_chat_operations SET state=?1,thread_id=COALESCE(?2,thread_id),turn_id=COALESCE(?3,turn_id),error_code=?4,updated_at=?5 WHERE operation_id=?6 AND state IN ('pending','ambiguous','reconciling')",
      [
        state,
        fields.threadId ?? null,
        fields.turnId ?? null,
        fields.errorCode ?? null,
        this.now(),
        operationId,
      ],
    );
  }

  private operationState(operationId: string): string | undefined {
    return this.store.db.get<{ state: string }>(
      "SELECT state FROM side_chat_operations WHERE operation_id=?1",
      operationId,
    )?.state;
  }

  private markAmbiguous(
    sideChatId: string,
    attemptId: string | undefined,
    operationId: string,
    error: unknown,
  ): void {
    const at = this.now();
    this.store.db.transaction(() => {
      this.store.db.run(
        "UPDATE side_chat_operations SET state='ambiguous',error_code=?1,updated_at=?2 WHERE operation_id=?3 AND state IN ('pending','reconciling')",
        [auditErrorReason(error), at, operationId],
      );
      if (attemptId)
        this.store.db.run(
          "UPDATE side_chat_attempts SET state='ambiguous',updated_at=?1 WHERE attempt_id=?2 AND state IN ('starting','running','reconciling')",
          [at, attemptId],
        );
      this.store.db.run(
        "UPDATE side_chats SET state='ambiguous',updated_at=?1 WHERE side_chat_id=?2 AND state != 'purged'",
        [at, sideChatId],
      );
      this.emitStored(
        sideChatId,
        attemptId,
        undefined,
        undefined,
        "operation.ambiguous",
        "ambiguous",
        "SIDE_THREAD_AMBIGUOUS",
        at,
      );
    });
  }

  private async acceptRuntimeEvent(
    event: SideThreadRuntimeEvent,
  ): Promise<void> {
    try {
      requireIdentity(event.sideChatId, "event.sideChatId");
      requireIdentity(event.attemptId, "event.attemptId");
      requireIdentity(event.threadId, "event.threadId");
      requireIdentity(event.turnId, "event.turnId");
      this.store.db.transaction(() => {
        const owned = this.store.db.get<any>(
          `SELECT c.active_attempt_id,c.derived_thread_id,a.state,a.turn_id FROM side_chats c JOIN side_chat_attempts a ON a.side_chat_id=c.side_chat_id AND a.attempt_id=?2 WHERE c.side_chat_id=?1`,
          event.sideChatId,
          event.attemptId,
        );
        const starting =
          (owned?.state === "starting" ||
            owned?.state === "ambiguous" ||
            owned?.state === "reconciling") &&
          !owned?.turn_id;
        if (!owned) return;
        if (
          owned.active_attempt_id !== event.attemptId ||
          owned.derived_thread_id !== event.threadId ||
          (!starting && owned.turn_id !== event.turnId) ||
          !(
            owned.state === "running" ||
            owned.state === "ambiguous" ||
            owned.state === "reconciling" ||
            starting
          )
        ) {
          this.emitStored(
            event.sideChatId,
            event.attemptId,
            event.threadId,
            event.turnId,
            "runtime_event.dropped",
            undefined,
            "ownership-mismatch",
            this.now(),
          );
          return;
        }
        const state =
          event.status === "completed"
            ? "completed"
            : event.status === "interrupted"
              ? "cancelled"
              : "failed";
        const t = this.now();
        const startOperation = this.store.db.get<{ operation_id: string }>(
          "SELECT operation_id FROM side_chat_operations WHERE side_chat_id=?1 AND attempt_id=?2 AND operation_kind='start' ORDER BY created_at DESC LIMIT 1",
          event.sideChatId,
          event.attemptId,
        );
        if (startOperation)
          this.settleOperation(startOperation.operation_id, "completed", {
            threadId: event.threadId,
            turnId: event.turnId,
          });
        this.store.db.run(
          "UPDATE side_chat_attempts SET state=?1,turn_id=COALESCE(turn_id,?2),result_text=?3,error_text=?4,updated_at=?5 WHERE attempt_id=?6 AND state IN ('starting','running','ambiguous','reconciling')",
          [
            state,
            event.turnId,
            event.status === "completed" ? safeResult(event.text) : null,
            event.status === "failed" ? safeReason(event.error) : null,
            t,
            event.attemptId,
          ],
        );
        this.store.db.run(
          "UPDATE side_chats SET state=?1,active_attempt_id=NULL,updated_at=?2 WHERE side_chat_id=?3 AND active_attempt_id=?4",
          [state, t, event.sideChatId, event.attemptId],
        );
        this.emitStored(
          event.sideChatId,
          event.attemptId,
          event.threadId,
          event.turnId,
          "attempt.terminal",
          state,
          event.status,
          t,
        );
      });
    } catch {
      /* malformed runtime events are untrusted and ignored */
    }
  }

  private failStarting(
    sideChatId: string,
    attemptId: string,
    error: unknown,
  ): void {
    const t = this.now(),
      reason = safeReason(
        error instanceof Error ? error.message : String(error),
      );
    this.store.db.transaction(() => {
      const changed = this.store.db.run(
        "UPDATE side_chat_attempts SET state='failed',error_text=?1,updated_at=?2 WHERE attempt_id=?3 AND state='starting'",
        [reason, t, attemptId],
      );
      if (changed.changes > 0) {
        this.store.db.run(
          "UPDATE side_chats SET state='failed',active_attempt_id=NULL,updated_at=?1 WHERE side_chat_id=?2 AND active_attempt_id=?3",
          [t, sideChatId, attemptId],
        );
        this.emitStored(
          sideChatId,
          attemptId,
          undefined,
          undefined,
          "attempt.failed",
          "failed",
          auditErrorReason(error),
          t,
        );
      }
    });
  }
  private emitStored(
    sideChatId: string,
    attemptId: string | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
    type: string,
    state: string | undefined,
    reason: string | undefined,
    at: number,
  ): void {
    this.store.db.run(
      "INSERT INTO side_chat_events (side_chat_id,attempt_id,thread_id,turn_id,event_type,state,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
      [
        sideChatId,
        attemptId ?? null,
        threadId ?? null,
        turnId ?? null,
        type,
        state ?? null,
        safeReason(reason) ?? null,
        at,
      ],
    );
    const row = this.store.db.get<any>(
      "SELECT event_id FROM side_chat_events WHERE side_chat_id=?1 ORDER BY event_id DESC LIMIT 1",
      sideChatId,
    );
    this.emitter.emit(`side:${sideChatId}`, {
      eventId: row?.event_id ?? 0,
      sideChatId,
      attemptId,
      threadId,
      turnId,
      type,
      state,
      reason: safeReason(reason),
      createdAt: at,
    } satisfies SideThreadEventRecord);
  }
  private mustOwned(
    sideChatId: string,
    actor: SideThreadActor,
  ): SideThreadRecord {
    const r = this.store.getOwned(sideChatId, actor);
    if (!r || !this.opts.authorizeNode(actor, r.networkId, r.nodeId))
      throw new SideThreadError(
        "SIDE_THREAD_NOT_FOUND",
        "side chat not found",
        404,
      );
    return r;
  }
  private async singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.inFlight.get(key);
    if (prior) return prior as Promise<T>;
    const op = fn();
    this.inFlight.set(key, op);
    try {
      return await op;
    } finally {
      if (this.inFlight.get(key) === op) this.inFlight.delete(key);
    }
  }
}

function validateCreateInput(input: CreateInput): void {
  requireKey(input.requestKey);
  requireIdentity(input.networkId, "networkId");
  requireIdentity(input.nodeId, "nodeId");
  requireIdentity(input.sourceThreadId, "sourceThreadId");
  if (input.boundary?.kind !== "through" && input.boundary?.kind !== "before")
    throw conflict("invalid exact boundary");
  requireIdentity(input.boundary.turnId, "boundary.turnId");
  requirePrompt(input.prompt);
}
function requireIdentity(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /[\r\n\0]/.test(value)
  )
    throw conflict(`invalid ${label}`);
}
function requireRuntimeIdentity(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /[\r\n\0]/.test(value)
  )
    throw runtimeProtocol(`runtime returned invalid ${label}`);
}
function requireKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value))
    throw conflict("invalid idempotency key");
}
function requirePrompt(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000)
    throw conflict("invalid prompt");
}
function normalizeAttachments(value: unknown): SideThreadAttachmentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    throw conflict("invalid attachments");
  const seen = new Set<string>();
  return value.map((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      Object.keys(v as object).some((k) => k !== "fileId") ||
      typeof (v as any).fileId !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test((v as any).fileId)
    )
      throw conflict("attachments must contain fileId references only");
    const fileId = (v as any).fileId;
    if (seen.has(fileId)) throw conflict("duplicate attachment reference");
    seen.add(fileId);
    return { fileId };
  });
}
function parseAttachmentJson(value: string): SideThreadAttachmentRef[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.fileId === "string" &&
          /^[A-Za-z0-9_-]{8,64}$/.test(entry.fileId),
      )
      .map((entry) => ({ fileId: entry.fileId }));
  } catch {
    return [];
  }
}
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}
function stableOperationId(
  sideChatId: string,
  kind: SideThreadOperationRecord["kind"],
  requestKey: string,
): string {
  return `sop_${hashJson([sideChatId, kind, requestKey]).slice(0, 40)}`;
}
function safeReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(?:Bearer\s+)?(?:(?:a|n|u)tok_|sk-)[A-Za-z0-9._-]+/gi,
      "[redacted]",
    )
    .slice(0, 300);
}
function safeResult(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 1_000_000);
}
function capabilityReason(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9-]{1,80}$/.test(reason)
    ? `native SideThread unavailable: ${reason}`
    : "native SideThread capability unavailable";
}
function capabilityReasonCode(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9-]{1,80}$/.test(reason)
    ? reason
    : "runtime-adapter-unavailable";
}
function auditErrorReason(error: unknown): string {
  const code = (error as any)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code
    : "runtime-error";
}
function conflict(message: string): SideThreadError {
  return new SideThreadError("SIDE_THREAD_CONFLICT", message, 409);
}
function runtimeProtocol(message: string): SideThreadError {
  return new SideThreadError("SIDE_THREAD_AMBIGUOUS", message, 202);
}
function isAmbiguousRuntimeError(error: unknown): boolean {
  const code = (error as any)?.code;
  return (
    code === "SIDE_THREAD_AMBIGUOUS" || code === "SIDE_THREAD_RESPONSE_LOST"
  );
}
function ambiguousError(
  operationId: string,
  sideChatId: string,
  attemptId?: string,
): SideThreadError {
  return new SideThreadError(
    "SIDE_THREAD_AMBIGUOUS",
    "runtime acceptance is ambiguous; reconcile this stable operation before retrying",
    202,
    operationId,
    sideChatId,
    attemptId,
  );
}
function normalizePortError(error: unknown): SideThreadError {
  if (error instanceof SideThreadError) return error;
  const code = (error as any)?.code;
  if (code === "SIDE_THREAD_UNSUPPORTED")
    return new SideThreadError(
      "SIDE_THREAD_UNSUPPORTED",
      "verified native SideThread adapter became unavailable",
      501,
    );
  return new SideThreadError(
    "SIDE_THREAD_RUNTIME_ERROR",
    "SideThread runtime operation failed",
    502,
  );
}
