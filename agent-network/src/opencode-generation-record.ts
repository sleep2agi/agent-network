// Board #542 — record which OpenCode generation a node was created/started
// for, so a later V2 backend (#543) can tell an existing V1 node from a new V2
// one without guessing from whatever `opencode` happens to be on PATH.
//
// Rules (no behaviour change for anything that exists today):
//   • Only `opencodeGeneration` is ever added, and only when it is absent.
//   • A present value — any value — is left exactly as written.
//   • A config without the field is V1 (every node before #542); readers use
//     `opencodeGenerationOfConfig()` from the shared table, never a default
//     of their own.

import { OPENCODE_DEFAULT_GENERATION, type OpencodeGeneration } from "./opencode-versions";

export const OPENCODE_GENERATION_FIELD = "opencodeGeneration";

/** Profile about to be serialised by saveProfile: add the generation when it
 *  is missing, otherwise return the very same object. */
export function stampOpencodeGeneration<T extends Record<string, any>>(
  profile: T,
  generation: OpencodeGeneration = OPENCODE_DEFAULT_GENERATION,
): T {
  if (profile[OPENCODE_GENERATION_FIELD] !== undefined) return profile;
  return { ...profile, [OPENCODE_GENERATION_FIELD]: generation };
}

/**
 * Raw `config.json` text → the same text with `opencodeGeneration` appended,
 * or null when nothing should be written:
 *   – the field is already present (whatever its value), or
 *   – the file is not valid JSON / not an object, or
 *   – the file is not in the canonical `JSON.stringify(_, null, 2) + "\n"`
 *     form saveProfile writes (hand-edited). Re-serialising such a file could
 *     touch bytes of other fields, and an absent field already means V1.
 * In the canonical case the result differs from the input only by the one
 * appended key, so every other field keeps its exact bytes.
 */
export function recordOpencodeGenerationInConfigText(
  raw: string,
  generation: OpencodeGeneration = OPENCODE_DEFAULT_GENERATION,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, OPENCODE_GENERATION_FIELD)) return null;
  if (JSON.stringify(record, null, 2) + "\n" !== raw) return null;
  return JSON.stringify({ ...record, [OPENCODE_GENERATION_FIELD]: generation }, null, 2) + "\n";
}

/** Start-time backfill for a node created before #542. IO is injected so the
 *  caller keeps its own symlink-safe private-file reader/writer. Never throws:
 *  the record is advisory and an absent field already reads as V1. */
export function backfillOpencodeGeneration(io: {
  read: () => string | undefined;
  write: (body: string) => void;
}): boolean {
  try {
    const raw = io.read();
    if (raw === undefined) return false;
    const next = recordOpencodeGenerationInConfigText(raw);
    if (next === null) return false;
    io.write(next);
    return true;
  } catch {
    return false;
  }
}
