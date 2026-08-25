import {
  SIDE_THREAD_API_ACTIONS,
  SIDE_THREAD_API_ROOT,
  SideThreadCoordinator,
  SideThreadError,
  type SideThreadActor,
  type SideThreadRecord,
} from "./side-thread.js";

export interface SideThreadHttpContext {
  req: Request;
  url: URL;
  actor: SideThreadActor | null;
  coordinator: SideThreadCoordinator;
  resolveCapabilityTarget?: (input: {
    actor: SideThreadActor;
    alias?: string;
    nodeId?: string;
    networkId?: string;
  }) => { nodeId: string; networkId: string } | undefined;
}

export async function handleSideThreadHttpRequest(
  ctx: SideThreadHttpContext,
): Promise<Response | null> {
  const root = ctx.url.pathname === SIDE_THREAD_API_ROOT;
  const capabilityPath =
    ctx.url.pathname === `${SIDE_THREAD_API_ROOT}/capability`;
  const match = ctx.url.pathname.match(
    new RegExp(
      `^${SIDE_THREAD_API_ROOT}/([^/]+)(?:/(${SIDE_THREAD_API_ACTIONS.join("|")}))?$`,
    ),
  );
  if (!root && !capabilityPath && !match) return null;
  if (!ctx.coordinator.isEnabled())
    return json({ ok: false, error: "SIDE_THREAD_DISABLED" }, 404);
  if (!ctx.actor)
    return json({ ok: false, error: "SIDE_THREAD_AUTH_REQUIRED" }, 401);

  try {
    if (capabilityPath) {
      if (ctx.req.method !== "GET") return methodNotAllowed("GET");
      const target = ctx.resolveCapabilityTarget?.({
        actor: ctx.actor,
        alias: query(ctx.url, "alias"),
        nodeId: query(ctx.url, "nodeId", "node_id"),
        networkId: query(ctx.url, "networkId", "network_id"),
      });
      if (!target)
        throw new SideThreadError(
          "SIDE_THREAD_NOT_FOUND",
          "node not found",
          404,
        );
      const sourceThreadId = requiredQueryIdentity(ctx.url, "sourceThreadId");
      const boundaryKind = query(ctx.url, "boundaryKind");
      const boundaryTurnId = requiredQueryIdentity(ctx.url, "boundaryTurnId");
      if (boundaryKind !== "through" && boundaryKind !== "before")
        throw new SideThreadError(
          "SIDE_THREAD_INVALID_CONTEXT",
          "boundaryKind must be through or before",
          400,
        );
      const boundary = { kind: boundaryKind, turnId: boundaryTurnId } as const;
      const capability = await ctx.coordinator.capability(
        ctx.actor,
        target.networkId,
        target.nodeId,
        boundary,
      );
      return json({
        ok: true,
        capability: serializeCapability(capability, {
          networkId: target.networkId,
          nodeId: target.nodeId,
          sourceThreadId,
          boundary,
        }),
      });
    }
    if (root && ctx.req.method === "GET") {
      const rawLimit = ctx.url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : parseLimit(rawLimit);
      if (rawLimit !== null && limit === null)
        throw new SideThreadError(
          "SIDE_THREAD_INVALID_LIMIT",
          "invalid list limit",
          400,
        );
      const records = ctx.coordinator.list(ctx.actor, {
        networkId: query(ctx.url, "networkId", "network_id"),
        nodeId: query(ctx.url, "nodeId", "node_id"),
        limit: limit ?? undefined,
      });
      return json({
        ok: true,
        sideThreads: records.map(serialize),
        count: records.length,
      });
    }
    if (root && ctx.req.method === "POST") {
      const body = await requestJson(ctx.req);
      const record = await ctx.coordinator.create(ctx.actor, {
        requestKey: field(body, "requestKey", "request_key"),
        networkId: field(body, "networkId", "network_id"),
        nodeId: field(body, "nodeId", "node_id"),
        sourceThreadId: field(body, "sourceThreadId", "source_thread_id"),
        boundary: {
          kind: body.boundary?.kind,
          turnId: field(body.boundary, "turnId", "turn_id"),
        },
        prompt: field(body, "question", "prompt"),
        attachments: mapAttachments(body.attachments),
      });
      return json({ ok: true, sideThread: serialize(record) }, 201);
    }
    if (root) return methodNotAllowed("GET, POST");

    const sideChatId = decodeSegment(match![1]);
    const action = match![2];
    if (!action && ctx.req.method === "GET") {
      return json({
        ok: true,
        sideThread: serialize(ctx.coordinator.get(ctx.actor, sideChatId)),
      });
    }
    if (!action) return methodNotAllowed("GET");

    if (action === "events" && ctx.req.method === "GET") {
      // Authorize before opening a long-lived stream. A non-owner gets the
      // same 404 as an unknown id and cannot infer another user's side chat.
      ctx.coordinator.get(ctx.actor, sideChatId);
      const headerCursor = ctx.req.headers.get("Last-Event-ID");
      const queryCursor = ctx.url.searchParams.get("after");
      const after = parseCursor(headerCursor ?? queryCursor);
      if (after === null)
        throw new SideThreadError(
          "SIDE_THREAD_INVALID_CURSOR",
          "invalid event cursor",
          400,
        );
      return sideThreadEventStream(
        ctx.coordinator,
        ctx.actor,
        sideChatId,
        after,
      );
    }

    if (ctx.req.method !== "POST") return methodNotAllowed("POST");
    if (action === "cancel") {
      return json({
        ok: true,
        sideThread: serialize(
          await ctx.coordinator.cancel(ctx.actor, sideChatId),
        ),
      });
    }
    if (action === "archive") {
      return json({
        ok: true,
        sideThread: serialize(
          await ctx.coordinator.archive(ctx.actor, sideChatId),
        ),
      });
    }
    if (action === "purge") {
      return json({
        ok: true,
        sideThread: serialize(
          await ctx.coordinator.purge(ctx.actor, sideChatId),
        ),
      });
    }
    const body = await requestJson(ctx.req);
    if (action === "retry") {
      return json({
        ok: true,
        sideThread: serialize(
          await ctx.coordinator.retry(ctx.actor, sideChatId, {
            requestKey: field(body, "requestKey", "request_key"),
            prompt: field(body, "question", "prompt"),
            attachments:
              body.attachments === undefined
                ? undefined
                : mapAttachments(body.attachments),
          }),
        ),
      });
    }
    const broughtBack = await ctx.coordinator.bringBack(ctx.actor, sideChatId, {
      requestKey: field(body, "requestKey", "request_key"),
      destinationThreadId: field(
        body,
        "destinationThreadId",
        "destination_thread_id",
      ),
      attemptId: field(body, "attemptId", "attempt_id"),
    });
    return json({ ok: true, bringBack: broughtBack });
  } catch (error) {
    if (error instanceof SideThreadError) {
      return json(
        {
          ok: false,
          error: error.code,
          message: error.message,
          ...(error.operationId ? { operationId: error.operationId } : {}),
          ...(error.sideChatId ? { sideThreadId: error.sideChatId } : {}),
          ...(error.attemptId ? { attemptId: error.attemptId } : {}),
        },
        error.status,
      );
    }
    return json({ ok: false, error: "SIDE_THREAD_INTERNAL_ERROR" }, 500);
  }
}

function serialize(record: SideThreadRecord) {
  const completedBringBackAttempts = new Set(
    record.bringBacks
      .filter((receipt) => receipt.state === "completed")
      .map((receipt) => receipt.attemptId),
  );
  return {
    sideThreadId: record.sideChatId,
    requestKey: record.requestKey,
    networkId: record.networkId,
    nodeId: record.nodeId,
    sourceThreadId: record.sourceThreadId,
    question: record.question,
    title: record.question.split(/\r?\n/, 1)[0].slice(0, 120),
    boundary: { kind: record.boundary.kind, turnId: record.boundary.turnId },
    threadId: record.threadId ?? null,
    state: record.state,
    activeAttemptId: record.activeAttemptId ?? null,
    capability: {
      runtime: record.runtime ?? null,
      runtimeVersion: record.runtimeVersion ?? null,
      topology: record.topology ?? null,
      evidenceRevision: record.evidenceRevision ?? null,
    },
    attachments: record.attachments.map((a) => ({ fileId: a.fileId })),
    attempts: record.attempts.map((a) => ({
      attemptId: a.attemptId,
      requestKey: a.requestKey,
      parentAttemptId: a.parentAttemptId ?? null,
      threadId: a.threadId ?? null,
      turnId: a.turnId ?? null,
      state: a.state,
      result: a.result ?? null,
      error: a.error ?? null,
      attachments: a.attachments.map((attachment) => ({
        fileId: attachment.fileId,
      })),
      broughtBack: completedBringBackAttempts.has(a.attemptId),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    bringBacks: record.bringBacks.map((receipt) => ({
      bringBackId: receipt.bringBackId,
      attemptId: receipt.attemptId,
      requestKey: receipt.requestKey,
      destinationThreadId: receipt.destinationThreadId,
      destinationTurnId: receipt.destinationTurnId ?? null,
      state: receipt.state,
      broughtBack: receipt.state === "completed",
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      completedAt: receipt.completedAt ?? null,
    })),
    operations: record.operations.map((operation) => ({
      operationId: operation.operationId,
      attemptId: operation.attemptId ?? null,
      kind: operation.kind,
      requestKey: operation.requestKey,
      state: operation.state,
      threadId: operation.threadId ?? null,
      turnId: operation.turnId ?? null,
      errorCode: operation.errorCode ?? null,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeCapability(
  capability: Awaited<ReturnType<SideThreadCoordinator["capability"]>>,
  context: {
    networkId: string;
    nodeId: string;
    sourceThreadId: string;
    boundary: { kind: "through" | "before"; turnId: string };
  },
) {
  return {
    enabled: true,
    supported: capability.supported,
    mode: capability.mode ?? null,
    runtime: capability.runtime ?? null,
    runtimeVersion: capability.runtimeVersion ?? null,
    topology: capability.topology ?? null,
    evidenceRevision: capability.evidenceRevision ?? null,
    exactBoundary: capability.exactBoundary ?? null,
    reason: capability.reason ?? null,
    context: capability.supported ? context : null,
  };
}

function sideThreadEventStream(
  coordinator: SideThreadCoordinator,
  actor: SideThreadActor,
  sideChatId: string,
  after: number,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (
          event: ReturnType<SideThreadCoordinator["listEvents"]>[number],
        ) => {
          if (closed) return;
          if ((controller.desiredSize ?? -262_145) < -262_144) {
            cleanup();
            try {
              controller.close();
            } catch {}
            return;
          }
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.eventId}\nevent: side_thread\ndata: ${JSON.stringify(serializeEvent(event))}\n\n`,
              ),
            );
          } catch {
            cleanup();
          }
        };
        for (const event of coordinator.listEvents(actor, sideChatId, after))
          send(event);
        if (closed) return;
        unsubscribe = coordinator.subscribe(sideChatId, send);
        heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? -262_145) < -262_144) {
            cleanup();
            try {
              controller.close();
            } catch {}
            return;
          }
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            cleanup();
          }
        }, 30_000);
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function serializeEvent(
  event: ReturnType<SideThreadCoordinator["listEvents"]>[number],
) {
  return {
    eventId: event.eventId,
    sideThreadId: event.sideChatId,
    attemptId: event.attemptId ?? null,
    threadId: event.threadId ?? null,
    turnId: event.turnId ?? null,
    type: event.type,
    state: event.state ?? null,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
  };
}

function mapAttachments(value: unknown): Array<{ fileId: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new SideThreadError(
      "SIDE_THREAD_CONFLICT",
      "invalid attachments",
      409,
    );
  return value.map((entry: any) => {
    if (!entry || typeof entry !== "object")
      return { fileId: undefined as any };
    // Do not forward path/url/name fields even temporarily. The coordinator
    // rejects the original shape when extra keys are present.
    const allowed = Object.keys(entry).every(
      (key) => key === "fileId" || key === "file_id",
    );
    return allowed
      ? { fileId: field(entry, "fileId", "file_id") }
      : { ...(entry as any), fileId: field(entry, "fileId", "file_id") };
  });
}

function field(value: any, camel: string, legacy: string): any {
  return value?.[camel] ?? value?.[legacy];
}

function query(url: URL, camel: string, legacy?: string): string | undefined {
  return (
    url.searchParams.get(camel) ??
    (legacy ? url.searchParams.get(legacy) : null) ??
    undefined
  );
}

function requiredQueryIdentity(url: URL, name: string): string {
  const value = query(url, name);
  if (!value || value.length > 512 || /[\r\n\0]/.test(value))
    throw new SideThreadError(
      "SIDE_THREAD_INVALID_CONTEXT",
      `invalid ${name}`,
      400,
    );
  return value;
}

async function requestJson(req: Request): Promise<any> {
  const contentType = req.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw new SideThreadError(
      "SIDE_THREAD_INVALID_BODY",
      "application/json required",
      415,
    );
  }
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SideThreadError(
        "SIDE_THREAD_INVALID_BODY",
        "JSON object required",
        400,
      );
    }
    return value;
  } catch {
    throw new SideThreadError("SIDE_THREAD_INVALID_BODY", "invalid JSON", 400);
  }
}
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SideThreadError(
      "SIDE_THREAD_NOT_FOUND",
      "side chat not found",
      404,
    );
  }
}
function parseCursor(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
function parseLimit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= 100 ? n : null;
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function methodNotAllowed(allow: string): Response {
  return Response.json(
    { ok: false, error: "SIDE_THREAD_METHOD_NOT_ALLOWED" },
    { status: 405, headers: { Allow: allow } },
  );
}
