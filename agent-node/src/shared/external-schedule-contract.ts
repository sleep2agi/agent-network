const FIELD_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function integer(text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new Error("invalid_cron");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid_cron");
  return value;
}

function validateAtom(atom: string, min: number, max: number): void {
  const [base, step, extra] = atom.split("/");
  if (extra !== undefined || !base) throw new Error("invalid_cron");
  if (step !== undefined) integer(step, 1, max - min + 1);
  if (base === "*") return;
  const range = base.split("-");
  if (range.length === 1) {
    integer(range[0], min, max);
    return;
  }
  if (range.length !== 2) throw new Error("invalid_cron");
  const start = integer(range[0], min, max);
  const end = integer(range[1], min, max);
  if (start > end) throw new Error("invalid_cron");
}

/** Strict five-field cron timing. It deliberately excludes commands, names,
 * @aliases, a sixth seconds field and every control character. */
export function parseManagedCronExpression(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 5 || raw.length > 120) throw new Error("invalid_cron");
  if (/[^\x20-\x7e]/.test(raw) || /[\r\n]/.test(raw)) throw new Error("invalid_cron");
  const fields = raw.trim().split(/ +/);
  if (fields.length !== 5) throw new Error("invalid_cron");
  fields.forEach((field, index) => {
    if (!field || !/^[0-9*/,-]+$/.test(field)) throw new Error("invalid_cron");
    for (const atom of field.split(",")) validateAtom(atom, FIELD_BOUNDS[index][0], FIELD_BOUNDS[index][1]);
  });
  return fields.join(" ");
}

export type ExternalSchedulePatch = { enabled?: boolean; cron?: string };

export function parseExternalSchedulePatch(raw: unknown): ExternalSchedulePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_patch");
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "cron")) throw new Error("invalid_patch");
  const patch: ExternalSchedulePatch = {};
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") throw new Error("invalid_enabled");
    patch.enabled = obj.enabled;
  }
  if (obj.cron !== undefined) patch.cron = parseManagedCronExpression(obj.cron);
  return patch;
}
