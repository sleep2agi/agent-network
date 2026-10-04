// #533 — the one way anet asks tmux for format output it then parses.
//
// Measured (tmux 3.3a, Debian bookworm, private -L socket), session `通信牛`:
//
//   LANG=C / POSIX / unset   -F '#{session_id}\t#{session_name}'  → `$0_______`
//   LANG=C.UTF-8             same                                 → `$0\t通信牛`
//   LANG=C, `tmux -u …`      same                                 → `$0\t通信牛`
//
// Outside a UTF-8 locale tmux sanitizes its own output: a TAB AND every byte of
// a non-ASCII session name become `_`. So a printable separator alone is not a
// fix — the CJK name itself is gone and no exact match can ever succeed.
// `-u` tells the tmux client to treat its output as UTF-8 regardless of
// LANG/LC_ALL/LC_CTYPE; unlike forcing `LC_ALL=C.UTF-8` it needs no locale to be
// installed on the machine.
//
// Belt and braces: fields are joined with a printable ASCII token instead of a
// TAB, so even a tmux that ignored `-u` could not merge two fields together.
//
// Callers then match names by exact string equality in code — never by handing
// tmux `-t =name` (fails for CJK on pane-targeting commands) or `-t name`
// (prefix match: `通信牛` hits `通信牛-appsrv`).

/** Field separator inside a `-F` format. Printable, so tmux never rewrites it. */
export const TMUX_FIELD_SEP = "|ANETSEP|";

/** Prefix tmux argv with `-u` so its output keeps UTF-8 names in any locale. */
export function tmuxUtf8Args(args: readonly string[]): string[] {
  return ["-u", ...args];
}

/** The `-F` format string for these fields. */
export function tmuxFormat(fields: readonly string[]): string {
  return fields.join(TMUX_FIELD_SEP);
}

/**
 * argv for a tmux listing whose output anet parses:
 * `tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"])`
 * → `["-u", "list-sessions", "-F", "#{session_id}|ANETSEP|#{session_name}"]`.
 * Pass the result to `execTmux` (which adds `-S` isolation in front).
 */
export function tmuxListArgs(command: readonly string[], fields: readonly string[]): string[] {
  return tmuxUtf8Args([...command, "-F", tmuxFormat(fields)]);
}

/**
 * Split tmux format output into rows of exactly `fieldCount` fields.
 * Lines with a different field count are dropped (never guessed at).
 * A line without the separator is read as a legacy TAB-separated row, so
 * fixtures and callers that captured the old wire shape still parse.
 */
export function parseTmuxRows(output: string, fieldCount: number): string[][] {
  const rows: string[][] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const fields = fieldCount === 1
      ? [line]
      : line.includes(TMUX_FIELD_SEP) ? line.split(TMUX_FIELD_SEP) : line.split("\t");
    if (fields.length !== fieldCount) continue;
    rows.push(fields);
  }
  return rows;
}
