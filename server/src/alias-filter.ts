// Parse the `filter_alias` argument of `get_all_status` into an exact-match
// IN list.
//
// Why this exists at all: on a 222-session hub the unfiltered response is about
// 259 KB — past what an MCP client accepts in one result. A caller who wanted
// the status of three specific nodes could not get it from the tool, and had to
// go around it to the REST API. The filter is the fix; this module is the part
// of it worth pinning, because the interesting behaviour is what happens to the
// inputs that are not a clean alias.
//
// Blank entries are DROPPED rather than matched. A trailing comma would
// otherwise produce `alias = ''`, which matches no row — and "no rows" reads
// exactly like "those nodes do not exist". The failure and the true answer
// would be indistinguishable to the caller, which is the thing to avoid.

export interface AliasFilter {
  /** Exact aliases to match. Empty means "no alias filtering". */
  aliases: string[];
  /** SQL fragment to append, or "" when there is nothing to filter on. */
  sql: string;
}

export function parseAliasFilter(raw: string | undefined | null): AliasFilter {
  const aliases = (raw ?? "")
    .split(",")
    .map(a => a.trim())
    .filter(Boolean);
  return {
    aliases,
    sql: aliases.length > 0 ? ` AND alias IN (${aliases.map(() => "?").join(",")})` : "",
  };
}
