export type TaskAuthOrigin = "user" | "node" | "legacy";

/** Stamp task metadata from server authentication facts, overriding spoofed input. */
export function stampTaskAuthOrigin(meta: unknown, origin: TaskAuthOrigin): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  return { ...(meta as Record<string, unknown>), auth_origin: origin };
}
