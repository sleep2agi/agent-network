# CommHub Server — tags over MCP, v0.9.0-preview.157

Ships `main` after `.156`. One new MCP tool and one Windows-only robustness fix.

```
@sleep2agi/commhub-server@0.9.0-preview.157
```

## What changed

- **`requirement_tags`** — the tag tree is now reachable over MCP, as **one** tool with an
  `action` switch (same shape as `departments`):

  | action | what it does |
  |---|---|
  | `list` | the tree: `name`, `parent_id` (`null` = root), `depth`, colour, usage counts, `can_manage` |
  | `rename` / `merge` / `delete` / `color` | exactly the REST `tags/ops` implementation, not a copy |
  | `reparent` | moves the tree edge only; a missing `parent` key is a `400`, while `null` / `""` moves the tag to the top level |

  Why one tool rather than `tags_list` + `tag_op`: `tools/list` has a hard byte ceiling
  (all 86,500 / node 64,500 / user 60,500) and two tools would break it. The ceilings were
  **not** raised to make room:

  | role | before | after | ceiling |
  |---|---|---|---|
  | all | 86,264 B | **86,018 B** | 86,500 |
  | node | 64,315 B | **64,486 B** | 64,500 |
  | user | 59,924 B | **59,678 B** | 60,500 |

  The room came from tightening 18 verbose tool descriptions (20–100 B each). Nothing was
  dropped from the information they carry, and the phrases the contract tests pin
  (`append-only`, `REPLACES the whole list`, `node tokens can only read projects`) are
  preserved verbatim. **A previous draft broke exactly those three phrases and CI caught it** —
  descriptions are part of the interface here, not decoration.

- **Node tokens can read, not write.** `list` works for a node token; a write stops at the
  `tags_write` gate (`403 user_token_required`) because renaming or merging a tag rewrites every
  card carrying it, including cards the caller cannot see. Opening `tags_write` to agents is a
  permission decision, not a code change, and is **not** made here.

## Windows: rename over a briefly-held private-state file

`agent-network/src/private-state.ts` gained `renamePrivateStateSync()`:

- **only on win32**, and only for "someone has it open for a moment" (`EPERM` / `EBUSY` /
  `EACCES`), retry with a bounded backoff of **10 / 25 / 50 / 100 / 200 ms** (max 5 attempts);
- any other error (`ENOENT`, …) is thrown on the first attempt;
- exhausting the backoff still throws — nothing is swallowed;
- **POSIX never retries**: there, renaming over an open file is supposed to succeed, and a retry
  would only hide a real bug.

`atomicWritePrivateFile()` now calls it, so every private-state writer benefits — not just
`windows-copresence.json`, which is where CI first hit it:

```
[anet] ❌ Windows Codex co-presence failed: EPERM: operation not permitted,
  rename '...\.windows-copresence.json.<rand>.tmp' -> '...\windows-copresence.json'
```

Atomicity is kept: this is still "write a temp file, then rename", never "write in place".

## Compatibility

- Additive on both counts. A client that never calls `requirement_tags` sees no change; the tag
  storage format is identical to `.155` / `.156`.
- The Windows change only alters behaviour on win32, and only in the "transiently held" case that
  previously threw.

## What this release does NOT do

- No tag UI in the client (the Hub side is what is changing here).
- No permission change: agents still cannot write tags.
- The byte budget is now very thin (**12 B under `all`, 14 B under `node`**). The next tool of any
  size requires merging or deleting an action first; the comment in
  `tool-audience-http.test.ts` says so at the point of failure.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v157-preview157"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.157
```

## Upgrade

```bash
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
DIR="$HOME/.commhub/runtime-v157-preview157"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.157"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# point HUB_RUNTIME_DIR at $DIR, then
pm2 reload commhub-hub --update-env
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.157"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v156-preview156` and reload. No schema change: a
rolled-back Hub simply stops listing `requirement_tags`, and the Windows retry goes back to a
single attempt.

## Verification

- `server/src/requirement-tag-ops-http.test.ts` — 24 pass (22 + 2 MCP: `list` returns the tree and
  `reparent` keeps the REST semantics including "a missing `parent` key is 400"; a node token can
  `list` but its write is refused and the tree is unchanged).
- `server/src/tool-audience-http.test.ts` — 12 pass (registry == TOOL_AUDIENCE, the four-role
  compat replay, and the three byte ceilings).
- `server/src/mcp-context-cost-http.test.ts` (5) and `requirement-tag-tree-http.test.ts` (18) pass.
- `agent-network/src/private-state.test.ts` — 12 pass (4 new: win32 retries with the exact
  backoff sequence, win32 stops after 5 attempts, linux does not retry at all, non-transient errors
  skip the backoff).
- `tests/test629-mcp-schema-policy/probe.ts` — `inventory_count=88`, source order matches.
- Docs: `docs-site/docs/api/mcp-tools.md` and the English counterpart each gained a
  `requirement_tags` row (97/97 indexed); `check-doc-claims`, `check-mcp-tool-anchor-sections`,
  `check-mcp-tool-index-coverage` pass locally.
- Published after: `scripts/verify-hub-release.sh 0.9.0-preview.157` must PASS.
