export type TmuxSession = { id: string; name: string };

export function parseTmuxSessions(output: string): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (name) sessions.push({ id, name });
  }
  return sessions;
}

/** Resolve by exact decoded session name, then attach by tmux's opaque ID.
 * This avoids tmux target prefix matching and works for Unicode names. */
export function findExactTmuxSession(output: string, expectedName: string): TmuxSession | null {
  return parseTmuxSessions(output).find((session) => session.name === expectedName) || null;
}
