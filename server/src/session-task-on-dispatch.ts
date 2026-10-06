// Board #668. A dispatch preview is what the hub shows before the node
// reports. Once the session is already working, that text is the task in
// flight — a newer message waits in the inbox and must not replace it.
// Idle and every other status still take the preview.

const PLACEHOLDER = /^\?\d+$/;

/** SQL expression for `sessions.task` on dispatch. `placeholder` is a `?N` bind. */
export function sessionTaskOnDispatch(placeholder: string): string {
  if (!PLACEHOLDER.test(placeholder)) {
    throw new Error("sessionTaskOnDispatch placeholder must be a ?N bind");
  }
  return `CASE WHEN status = 'working' THEN task ELSE ${placeholder} END`;
}
