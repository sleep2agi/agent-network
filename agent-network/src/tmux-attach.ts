import { parseTmuxRows, tmuxListArgs } from "./tmux-format";

export type TmuxSession = { id: string; name: string };

/** argv for `execTmux`: `-u list-sessions -F '#{session_id}|ANETSEP|#{session_name}'` (#533). */
export const SESSION_LIST_ARGS: readonly string[] = tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"]);

/** Parse SESSION_LIST_ARGS output (legacy `id\tname` rows still accepted). */
export function parseTmuxSessions(output: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const [id, name] of parseTmuxRows(output, 2)) {
    if (id && name) sessions.push({ id, name });
  }
  return sessions;
}

/** Resolve by exact decoded session name, then attach by tmux's opaque ID.
 * This avoids tmux target prefix matching and works for Unicode names. */
export function findExactTmuxSession(output: string, expectedName: string): TmuxSession | null {
  return parseTmuxSessions(output).find((session) => session.name === expectedName) || null;
}
