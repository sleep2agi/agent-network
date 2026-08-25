// Agents can upload a file (`commhub_upload_file` → file_id) but have no way to
// ATTACH it to what they send. `commhub_reply` and `commhub_send_task` never
// took an `attachments` argument and never forwarded one, so the only way to
// get a file to the Dashboard was to paste the id into the message text:
//
//     图片 file_id: e697d597107f418ba1fe7d71e9464b98
//     取回: GET /api/files/e697d597107f418ba1fe7d71e9464b98 (需 Bearer)
//
// which is exactly what the Desktop renders — internal retrieval instructions
// as prose, no thumbnail, no download (agent-network-app#173).
//
// The Hub already accepts them: `send_reply` has a top-level `attachments`
// param and `send_task` reads `meta.attachments`, both persisted into
// `meta_json`. Inbound is handled too (channel-attachments.ts downloads and
// surfaces them). Only the outbound half of this node's MCP shim was missing.
//
// This module is the pure half: shape-check and normalize what a caller hands
// us, so the two call sites stay three lines each and the rules are testable
// without a Hub.

/** One attachment as the Hub stores it. `file_id` comes from commhub_upload_file. */
export interface OutboundAttachment {
  type: "file";
  file_id: string;
  name?: string;
  mime?: string;
  size?: number;
}

export type NormalizeResult =
  | { ok: true; attachments: OutboundAttachment[] }
  | { ok: false; error: string };

/** Same shape the Hub validates against — reject here so the caller gets a
 *  useful message instead of a rejected write it has to interpret. */
const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ATTACHMENTS = 10;

/**
 * Normalize caller-supplied attachments into what the Hub expects.
 *
 * Absent input is not an error and yields no `attachments` key at all — a call
 * without attachments must produce a byte-identical request to before this
 * existed, or every existing reply changes behaviour the day this ships.
 */
export function normalizeOutboundAttachments(input: unknown): NormalizeResult {
  if (input === undefined || input === null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) {
    return { ok: false, error: "attachments must be an array of { file_id, name?, mime?, size? }" };
  }
  if (input.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `too many attachments (${input.length} > ${MAX_ATTACHMENTS})` };
  }

  const out: OutboundAttachment[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    // A bare string is the shape people reach for first — accept it rather than
    // making them wrap a single id in an object.
    const item = typeof raw === "string" ? { file_id: raw } : raw;
    if (!item || typeof item !== "object") {
      return { ok: false, error: `attachments[${i}] must be a file_id string or an object` };
    }

    const fileId = (item as any).file_id;
    if (typeof fileId !== "string" || !FILE_ID.test(fileId)) {
      return {
        ok: false,
        error: `attachments[${i}].file_id must be the id returned by commhub_upload_file (8-64 chars of A-Za-z0-9_-), got ${JSON.stringify(fileId)}`,
      };
    }
    // The same file twice would render twice; the caller almost never means it.
    if (seen.has(fileId)) {
      return { ok: false, error: `attachments[${i}].file_id is a duplicate: ${fileId}` };
    }
    seen.add(fileId);

    const entry: OutboundAttachment = { type: "file", file_id: fileId };
    const name = (item as any).name;
    const mime = (item as any).mime;
    const size = (item as any).size;
    // Optional fields are carried through only when usable — a malformed hint
    // is dropped rather than rejected, because it never changes WHICH file the
    // Dashboard fetches, only how it labels it.
    if (typeof name === "string" && name.trim()) entry.name = name.trim().slice(0, 200);
    if (typeof mime === "string" && mime.trim()) entry.mime = mime.trim().slice(0, 100);
    if (Number.isFinite(size) && (size as number) >= 0) entry.size = Math.floor(size as number);
    out.push(entry);
  }

  return { ok: true, attachments: out };
}

/**
 * Spread into a Hub request body. Empty → `{}`, so a call with no attachments
 * is unchanged from before this module existed.
 */
export function attachmentsField(attachments: readonly OutboundAttachment[]): Record<string, unknown> {
  return attachments.length ? { attachments: attachments.map((a) => ({ ...a })) } : {};
}

/** `send_task` carries them under `meta`, not at the top level. */
export function attachmentsMeta(
  attachments: readonly OutboundAttachment[],
  existingMeta?: unknown,
): Record<string, unknown> {
  const base = existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
    ? { ...(existingMeta as Record<string, unknown>) }
    : undefined;
  if (!attachments.length) return base ? { meta: base } : {};
  return { meta: { ...(base ?? {}), attachments: attachments.map((a) => ({ ...a })) } };
}

/** Shared wording for the two tool schemas, so they cannot drift apart. */
export const ATTACHMENTS_SCHEMA = {
  type: "array" as const,
  description:
    "Optional files to attach. Each item is a file_id from commhub_upload_file, or { file_id, name?, mime?, size? }. " +
    "Attach files this way instead of writing the file_id into the message text — the Dashboard renders attachments as " +
    "thumbnails with a download entry, but renders a pasted file_id as plain prose (agent-network-app#173).",
  items: {
    type: "object" as const,
    properties: {
      file_id: { type: "string", description: "The file_id returned by commhub_upload_file" },
      name: { type: "string", description: "Display name, e.g. chart.png" },
      mime: { type: "string", description: "MIME type, e.g. image/png" },
      size: { type: "number", description: "Size in bytes" },
    },
    required: ["file_id"],
  },
};
