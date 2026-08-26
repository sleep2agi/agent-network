import {
  SideThreadAmbiguousError,
  SideThreadUnsupportedError,
  type ExactBoundary,
  type SideThreadRuntimeAdapter,
  type SideThreadTerminalEvent,
} from "./domain";

export const SIDE_THREAD_COMMAND_PROTOCOL = "side_thread.command.v1" as const;
export const SIDE_THREAD_ACK_PROTOCOL = "side_thread.ack.v1" as const;
export const SIDE_THREAD_TERMINAL_PROTOCOL = "side_thread.terminal.v1" as const;

export type SideThreadCommandKind =
  | "fork"
  | "start"
  | "cancel"
  | "archive"
  | "purge"
  | "bring-back";

export interface SideThreadAttachmentGrant {
  fileId: string;
  grantId: string;
  sha256: string;
  size: number;
  mediaType: string;
}

type CommandBase = {
  protocol: typeof SIDE_THREAD_COMMAND_PROTOCOL;
  commandId: string;
  operationId: string;
  requestKey: string;
  nodeId: string;
  sideThreadId: string;
  attemptId: string | null;
};

export type SideThreadCommand = CommandBase & (
  | { kind: "fork"; payload: { sourceThreadId: string; boundary: ExactBoundary } }
  | { kind: "start"; payload: { threadId: string; question: string; attachments: SideThreadAttachmentGrant[] } }
  | { kind: "cancel"; payload: { threadId: string; turnId: string } }
  | { kind: "archive" | "purge"; payload: { threadId: string } }
  | { kind: "bring-back"; payload: { sourceThreadId: string; sourceTurnId: string; destinationThreadId: string; text: string } }
);

export interface SideThreadCommandAck {
  protocol: typeof SIDE_THREAD_ACK_PROTOCOL;
  commandId: string;
  operationId: string;
  state: "accepted" | "ambiguous" | "failed" | "unsupported";
  errorCode: "SIDE_THREAD_AMBIGUOUS" | "SIDE_THREAD_CONFLICT" | "SIDE_THREAD_UNSUPPORTED" | null;
  result: {
    threadId: string | null;
    turnId: string | null;
    destinationTurnId: string | null;
  };
}

export interface SideThreadTerminalEnvelope {
  protocol: typeof SIDE_THREAD_TERMINAL_PROTOCOL;
  sideThreadId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text: string | null;
  errorCode: "SIDE_THREAD_RUNTIME_FAILED" | null;
}

export interface SideThreadCommandExecutorOptions {
  nodeId: string;
  adapter: SideThreadRuntimeAdapter;
  emitTerminal: (event: SideThreadTerminalEnvelope) => void | Promise<void>;
  receipts: SideThreadCommandReceiptStore;
  materializeAttachment?: (grant: SideThreadAttachmentGrant) => Promise<{
    path: string; mediaType: string; sha256: string; size: number;
  }>;
  bringBack?: (input: {
    commandId: string; operationId: string; requestKey: string;
    sideThreadId: string; attemptId: string; sourceThreadId: string;
    sourceTurnId: string; destinationThreadId: string; text: string;
  }) => Promise<{ destinationTurnId: string }>;
  onDroppedTerminal?: (reason: "identity-unbound" | "invalid-terminal") => void;
}

export interface SideThreadCommandReceiptStore {
  get(commandId: string): SideThreadCommandReceipt | undefined;
  put(receipt: SideThreadCommandReceipt): void;
}

export interface SideThreadCommandReceipt {
  version: 1;
  commandId: string;
  fingerprint: string;
  ack: SideThreadCommandAck;
}

/**
 * Dedicated node-side command boundary. It maps only SideThread commands to
 * the native adapter: there is deliberately no task/inbox callback here.
 * Attachments and bring-back stay unsupported until their native, journaled
 * implementations are installed; they must never degrade to ordinary tasks.
 */
export class SideThreadCommandExecutor {
  private readonly unsubscribe: () => void;

  constructor(private readonly options: SideThreadCommandExecutorOptions) {
    requireIdentity(options.nodeId, "nodeId");
    this.unsubscribe = options.adapter.subscribe((event) => {
      void this.forwardTerminal(event);
    });
  }

  capability() {
    return this.options.adapter.capability();
  }

  close(): void {
    this.unsubscribe();
  }

  async execute(raw: unknown): Promise<SideThreadCommandAck> {
    const command = parseSideThreadCommand(raw);
    const fingerprint = commandFingerprint(command);
    const prior = this.options.receipts.get(command.commandId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return ack(command, "failed", "SIDE_THREAD_CONFLICT");
      return structuredClone(prior.ack);
    }
    if (command.nodeId !== this.options.nodeId) {
      return this.remember(command, fingerprint, ack(command, "failed", "SIDE_THREAD_CONFLICT"));
    }
    const operation = {
      nodeId: command.nodeId,
      operationId: command.operationId,
      idempotencyKey: command.requestKey,
    };
    try {
      switch (command.kind) {
        case "fork": {
          const result = await this.options.adapter.fork({
            sideThreadId: command.sideThreadId,
            sourceThreadId: command.payload.sourceThreadId,
            boundary: command.payload.boundary,
            operation,
          });
          return this.remember(command, fingerprint, ack(command, "accepted", null, { threadId: result.derivedThreadId }));
        }
        case "start": {
          if (!command.attemptId) return this.remember(command, fingerprint, ack(command, "failed", "SIDE_THREAD_CONFLICT"));
          if (command.payload.attachments.length > 0 && !this.options.materializeAttachment)
            return this.remember(command, fingerprint, ack(command, "unsupported", "SIDE_THREAD_UNSUPPORTED"));
          // Materialize every grant before turn/start. Partial attachment input
          // is never silently downgraded to a text-only turn.
          const attachments = await Promise.all(command.payload.attachments.map(async (grant) => {
            const local = await this.options.materializeAttachment!(grant);
            if (local.sha256 !== grant.sha256 || local.size !== grant.size || local.mediaType !== grant.mediaType)
              throw new SideThreadUnsupportedError("runtime", "attachment grant verification failed");
            return local;
          }));
          const result = await this.options.adapter.start({
            sideThreadId: command.sideThreadId,
            attemptId: command.attemptId,
            derivedThreadId: command.payload.threadId,
            prompt: command.payload.question,
            attachments,
            operation,
          });
          return this.remember(command, fingerprint, ack(command, "accepted", null, { turnId: result.turnId }));
        }
        case "cancel":
          await this.options.adapter.cancel({
            sideThreadId: command.sideThreadId,
            derivedThreadId: command.payload.threadId,
            turnId: command.payload.turnId,
            operation,
          });
          return this.remember(command, fingerprint, ack(command, "accepted", null));
        case "archive":
          await this.options.adapter.archive({
            sideThreadId: command.sideThreadId,
            derivedThreadId: command.payload.threadId,
            operation,
          });
          return this.remember(command, fingerprint, ack(command, "accepted", null));
        case "purge":
          await this.options.adapter.delete({
            sideThreadId: command.sideThreadId,
            derivedThreadId: command.payload.threadId,
            operation,
          });
          return this.remember(command, fingerprint, ack(command, "accepted", null));
        case "bring-back":
          if (!command.attemptId || !this.options.bringBack)
            return this.remember(command, fingerprint, ack(command, "unsupported", "SIDE_THREAD_UNSUPPORTED"));
          // The injected implementation is required to be native and
          // journaled. Absence fails closed; there is no task/FIFO fallback.
          const brought = await this.options.bringBack({
            commandId: command.commandId, operationId: command.operationId,
            requestKey: command.requestKey, sideThreadId: command.sideThreadId,
            attemptId: command.attemptId, ...command.payload,
          });
          requireIdentity(brought.destinationTurnId, "destinationTurnId");
          return this.remember(command, fingerprint, ack(command, "accepted", null, { destinationTurnId: brought.destinationTurnId }));
      }
    } catch (error) {
      if (error instanceof SideThreadAmbiguousError)
        return this.remember(command, fingerprint, ack(command, "ambiguous", "SIDE_THREAD_AMBIGUOUS"));
      if (error instanceof SideThreadUnsupportedError)
        return this.remember(command, fingerprint, ack(command, "unsupported", "SIDE_THREAD_UNSUPPORTED"));
      return this.remember(command, fingerprint, ack(command, "failed", "SIDE_THREAD_CONFLICT"));
    }
  }

  private remember(command: SideThreadCommand, fingerprint: string, value: SideThreadCommandAck): SideThreadCommandAck {
    this.options.receipts.put({ version: 1, commandId: command.commandId, fingerprint, ack: value });
    return value;
  }

  private async forwardTerminal(event: SideThreadTerminalEvent): Promise<void> {
    if (event.identityBound !== true) {
      this.options.onDroppedTerminal?.("identity-unbound");
      return;
    }
    try {
      requireIdentity(event.sideThreadId, "sideThreadId");
      requireIdentity(event.attemptId, "attemptId");
      requireIdentity(event.threadId, "threadId");
      requireIdentity(event.turnId, "turnId");
    } catch {
      this.options.onDroppedTerminal?.("invalid-terminal");
      return;
    }
    await this.options.emitTerminal({
      protocol: SIDE_THREAD_TERMINAL_PROTOCOL,
      sideThreadId: event.sideThreadId,
      attemptId: event.attemptId,
      threadId: event.threadId,
      turnId: event.turnId,
      status: event.status,
      text: event.status === "completed" ? event.text ?? "" : null,
      errorCode: event.status === "failed" ? "SIDE_THREAD_RUNTIME_FAILED" : null,
    });
  }
}

function commandFingerprint(command: SideThreadCommand): string {
  return JSON.stringify(command);
}

export function parseSideThreadCommand(raw: unknown): SideThreadCommand {
  const value = record(raw, "command");
  if (value.protocol !== SIDE_THREAD_COMMAND_PROTOCOL) throw new Error("unsupported protocol");
  const base = {
    protocol: SIDE_THREAD_COMMAND_PROTOCOL,
    commandId: identity(value.commandId, "commandId"),
    operationId: identity(value.operationId, "operationId"),
    requestKey: identity(value.requestKey, "requestKey"),
    nodeId: identity(value.nodeId, "nodeId"),
    sideThreadId: identity(value.sideThreadId, "sideThreadId"),
    attemptId: nullableIdentity(value.attemptId, "attemptId"),
  };
  const payload = record(value.payload, "payload");
  switch (value.kind) {
    case "fork": {
      const boundary = record(payload.boundary, "boundary");
      if (boundary.kind !== "through" && boundary.kind !== "before") throw new Error("invalid boundary kind");
      return { ...base, kind: "fork", payload: {
        sourceThreadId: identity(payload.sourceThreadId, "sourceThreadId"),
        boundary: { kind: boundary.kind, turnId: identity(boundary.turnId, "boundary.turnId") },
      } };
    }
    case "start":
      return { ...base, kind: "start", payload: {
        threadId: identity(payload.threadId, "threadId"),
        question: text(payload.question, "question"),
        attachments: attachmentGrants(payload.attachments),
      } };
    case "cancel":
      return { ...base, kind: "cancel", payload: {
        threadId: identity(payload.threadId, "threadId"),
        turnId: identity(payload.turnId, "turnId"),
      } };
    case "archive":
    case "purge":
      return { ...base, kind: value.kind, payload: { threadId: identity(payload.threadId, "threadId") } };
    case "bring-back":
      return { ...base, kind: "bring-back", payload: {
        sourceThreadId: identity(payload.sourceThreadId, "sourceThreadId"),
        sourceTurnId: identity(payload.sourceTurnId, "sourceTurnId"),
        destinationThreadId: identity(payload.destinationThreadId, "destinationThreadId"),
        text: text(payload.text, "text"),
      } };
    default:
      throw new Error("unsupported command kind");
  }
}

function ack(
  command: SideThreadCommand,
  state: SideThreadCommandAck["state"],
  errorCode: SideThreadCommandAck["errorCode"],
  result: Partial<SideThreadCommandAck["result"]> = {},
): SideThreadCommandAck {
  return {
    protocol: SIDE_THREAD_ACK_PROTOCOL,
    commandId: command.commandId,
    operationId: command.operationId,
    state,
    errorCode,
    result: {
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null,
      destinationTurnId: result.destinationTurnId ?? null,
    },
  };
}

function attachmentGrants(raw: unknown): SideThreadAttachmentGrant[] {
  if (!Array.isArray(raw) || raw.length > 20) throw new Error("invalid attachments");
  return raw.map((item) => {
    const value = record(item, "attachment");
    const sha256 = text(value.sha256, "attachment.sha256");
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid attachment sha256");
    if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) throw new Error("invalid attachment size");
    return {
      fileId: identity(value.fileId, "attachment.fileId"),
      grantId: identity(value.grantId, "attachment.grantId"),
      sha256,
      size: Number(value.size),
      mediaType: text(value.mediaType, "attachment.mediaType"),
    };
  });
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, any>;
}

function identity(value: unknown, label: string): string {
  requireIdentity(value, label);
  return value as string;
}

function nullableIdentity(value: unknown, label: string): string | null {
  return value === null ? null : identity(value, label);
}

function requireIdentity(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 1_000_000) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
