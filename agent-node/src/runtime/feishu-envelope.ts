/**
 * RFC-020 §17.1 — feishu IPC envelope parsing (pure helper).
 *
 * Single source of truth for resolving the inbound attachment list
 * from a `FeishuBridgeEnvelope.event.content`. Old bridges ship just
 * `content.images: string[]` (legacy); newer bridges add
 * `content.attachments[]` carrying `file_id` for cross-machine
 * delegation (RFC-020 §17). This helper:
 *
 *   - prefers `attachments[]` when populated (carries the richer
 *     metadata + file_id)
 *   - falls back to `images: string[]` from older bridges (rolling
 *     upgrade safety)
 *   - drops malformed entries (non-string path, empty path, null,
 *     etc.) defensively so a hostile envelope can't crash the
 *     handler
 *
 * Extracted from the cli.ts IPC handler so unit tests bind the real
 * function instead of mirroring it. Pre-extraction the test
 * `feishu-envelope-compat.test.ts` had a sibling
 * `buildAttachmentDescriptors` that would silently drift if the
 * production logic changed — bind to the real one so a change in
 * cli.ts trips a red test.
 */

export interface FeishuInboundContent {
  text?: string;
  /** Legacy string[] of paths (RFC-020 pre-§17). Populated by all
   *  bridges for rolling-upgrade safety. */
  images?: string[];
  /** RFC-020 §17 attachment descriptors carrying file_id for
   *  cross-machine delegation. Populated by newer bridges after
   *  uploading inbound files to `/api/upload`. */
  attachments?: Array<{
    type?: "image" | "file";
    path?: string;
    file_id?: string;
    mime?: string;
    name?: string;
    size?: number;
  }>;
}

/** One inbound attachment as resolved from the envelope, ready to be
 *  surfaced into the agent's prompt and (optionally) re-stamped onto
 *  outbound `commhub_send_task(meta.attachments)`. */
export interface InboundAttachmentDescriptor {
  path: string;
  file_id?: string;
  mime?: string;
  name?: string;
  size?: number;
}

export interface FeishuRuntimeOriginInput {
  sender?: { id?: string };
  conversation?: {
    conversationType?: string;
    conversationId?: string;
  };
}

/**
 * Build the provenance label injected into a runtime turn.
 *
 * Shared TUI runtimes render `from` inside their visible task envelope.  The
 * old Feishu path used only `feishu:<conversationId>`, so an operator could
 * tell which chat a turn came from but not which Feishu member sent it.  Keep
 * the stable `feishu:` channel prefix (used by the Feishu tool deny gate), add
 * conversation type + sender id, and make every untrusted wire component safe
 * for the bracket-delimited Codex/Grok envelopes and terminal UI.
 */
export function buildFeishuRuntimeOrigin(event: FeishuRuntimeOriginInput): string {
  const safePart = (value: unknown, fallback: string): string => {
    if (typeof value !== "string") return fallback;
    const normalized = value
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\]\/\\]/g, "_")
      .replace(/\s+/g, "_")
      // Feishu open_id/chat_id/type values are ASCII identifiers. Keeping the
      // alphabet narrow makes the byte bound exact (important for Grok's
      // 256-byte envelope guard) and avoids Unicode bidi/confusable labels.
      .replace(/[^A-Za-z0-9_.:@+-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return normalized || fallback;
  };

  const type = safePart(event.conversation?.conversationType, "unknown");
  const conversationId = safePart(event.conversation?.conversationId, "unknown");
  const senderId = safePart(event.sender?.id, "unknown");
  return `feishu:${type}:${conversationId}:${senderId}`;
}

/**
 * Resolve the unified attachment descriptor list from the envelope's
 * `content` field, preferring the new `attachments[]` shape over the
 * legacy `images: string[]` for rolling-upgrade safety.
 *
 * Behavior contract (locked by `feishu-envelope-compat.test.ts`):
 *
 *   1. `content` is null / undefined → return `[]`.
 *   2. `content.attachments[]` non-empty → use it; filter entries
 *      that aren't `{ path: string, length > 0 }`.
 *   3. else `content.images[]` non-empty → use it as path-only
 *      descriptors; filter non-string / empty entries.
 *   4. else → return `[]`.
 *
 * No I/O. No SDK calls. Pure function — safe to call from tests.
 */
export function buildAttachmentDescriptors(
  content: FeishuInboundContent | null | undefined,
): InboundAttachmentDescriptor[] {
  if (!content || typeof content !== "object") return [];

  const fromAttachments = Array.isArray(content.attachments)
    ? content.attachments
        .filter(
          (a: any): a is FeishuInboundContent["attachments"] extends Array<infer T> ? T : never =>
            a !== null &&
            typeof a === "object" &&
            typeof a.path === "string" &&
            a.path.length > 0,
        )
        .map((a) => ({
          path: a.path as string,
          file_id: typeof a.file_id === "string" ? a.file_id : undefined,
          mime: typeof a.mime === "string" ? a.mime : undefined,
          name: typeof a.name === "string" ? a.name : undefined,
          size: typeof a.size === "number" ? a.size : undefined,
        }))
    : [];

  if (fromAttachments.length > 0) return fromAttachments;

  // Older bridge (legacy worker): fall back to `images: string[]`.
  const legacy = Array.isArray(content.images) ? content.images : [];
  return legacy
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => ({ path: p }));
}
