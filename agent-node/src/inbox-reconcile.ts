export const DEFAULT_INBOX_RECONCILE_MS = 15_000;
export const MIN_INBOX_RECONCILE_MS = 1_000;

export function resolveInboxReconcileMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INBOX_RECONCILE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < MIN_INBOX_RECONCILE_MS) {
    return DEFAULT_INBOX_RECONCILE_MS;
  }
  return value;
}
