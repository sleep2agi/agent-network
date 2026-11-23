// Control messages (stop the running turn) must not wait behind the turn they are meant to stop.
//
// The work lane is serial: it awaits a whole model turn, so a control row fetched there is only
// seen after the turn has ended, when there is nothing left to stop. This lane fetches and handles
// control rows on its own, as soon as the Hub announces one, for every runtime.
//
// The work lane still sees control rows as a fallback (a missed stream event, a reconnect). The
// handled-id set below makes sure a row handled here is not handled again there.

export type InboxRow = { id: string; type?: string };

export const isControlRow = (row: InboxRow): boolean => (row.type || "task") === "control";

/** Remembers the most recent ids only; old ones can no longer be redelivered as unhandled. */
export function createHandledIds(limit = 200) {
  const ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    add(id: string) {
      ids.delete(id);
      ids.add(id);
      while (ids.size > limit) ids.delete(ids.values().next().value as string);
    },
    get size() { return ids.size; },
  };
}

/**
 * Returns `kick()`: fetch the inbox now and handle every control row, without waiting for the
 * work lane. Calls made while a pass is running are folded into one more pass afterwards, so a
 * burst of stream events costs at most two fetches.
 */
export function createControlLane<Row extends InboxRow>(deps: {
  fetchInbox: () => Promise<Row[]>;
  handle: (row: Row) => Promise<void>;
  warn: (message: string) => void;
}): () => Promise<void> {
  let running = false;
  let again = false;
  return async function kick(): Promise<void> {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const rows = await deps.fetchInbox();
        for (const row of rows) {
          if (!isControlRow(row)) continue;
          try {
            await deps.handle(row);
          } catch (e: any) {
            deps.warn(`[control] handling ${String(row.id).slice(0, 8)} failed: ${e?.message ?? e}`);
          }
        }
      } while (again);
    } catch (e: any) {
      deps.warn(`[control] concurrent drain failed: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
}
