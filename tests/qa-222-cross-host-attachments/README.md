# qa-222-cross-host-attachments — issue #222 e2e

End-to-end test harness for **cross-machine attachment fetch**.

## What it proves (real HTTP + fs, not mocked)

| # | Scenario | Real artifact verified |
|---|----------|------------------------|
| 1 | POST /api/upload → file_id | upload + index entry written |
| 2 | agent GET /api/files/<id> with ntok | cache file written + chmod 600 + bytes match |
| 3 | second fetch same file_id | `cached: true`, no HTTP call |
| 4 | size cap (maxBytes=5, real file=62) | `size_exceeded` pre-stream, no cache file leaked |
| 5 | cross-tenant fetch | stranger's utok returns 200 (PRE-EXISTING any-valid-token model — documented in PR body as backlog); no-auth returns 401 |
| 6 | path-only fallback | local path returned as-is when file_id absent; missing path returns `not_found` honestly |
| 7 | TTL sweeper | backdated cache file purged on `sweepAttachmentCacheOnce` |

## How to run

```bash
docker build -t qa-222:local -f tests/qa-222-cross-host-attachments/Dockerfile .
docker run --rm qa-222:local
```

Hermetic: own port 9238, own COMMHUB_DB, own COMMHUB_UPLOADS_ROOT, own cache dir. Coexists with qa-rfc026 + qa-rfc027.

Expected: `PASS=21 FAIL=0`.

## Files

- `Dockerfile` — bookworm-slim install path mirroring qa-rfc026/qa-rfc027
- `run.sh` — pure bash + curl + jq + `bun -e` to call the agent-side resolver against a real hub. ~150 lines.
