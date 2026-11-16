// Pure state comparisons; no grant, identity, or database side effects.
export function isPermissionModeTightening(previous: string, next: string): boolean {
  const order = ["normal", "restricted", "readonly"];
  const before = order.indexOf(previous), after = order.indexOf(next);
  return before >= 0 && after >= before;
}

export function isInboxTightening(previous: readonly string[] | null, next: readonly string[] | null): boolean {
  // [] is rejected at the HTTP boundary; normalizePeerAllowlist treats it as unlimited.
  if (!next?.length) return false;
  // !strict disables implicit human bypass; removing it would widen access.
  if (previous?.includes("!strict") && !next.includes("!strict")) return false;
  return previous === null || next.every(sender => previous.includes(sender));
}
