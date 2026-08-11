# #693 Design: agent local file → Hub file_id bridge

## Choice: Scheme A (not B)

**A. MCP `upload_file`** (chosen): agent-side path validation + HTTP stream to existing Hub `POST /api/upload` → `{file_id,name,mime,size}` → `send_reply` attachments with `file_id` only.

**B. send_reply auto-uploads paths** rejected as primary: conflates validation surfaces, harder to audit, and still needs the same path allowlist — but hides upload as a side effect of reply. Keep Hub `validateAttachments` file_id-only (no bare path).

### Why A is safer / cross-host correct
1. **Cross-host**: bytes leave the agent host over multipart HTTP; Hub never opens agent paths.
2. **Boundary clarity**: path policy lives only on the token-bound node; Hub authz/network scope stays on `/api/upload` + `/api/files`.
3. **No send_reply gate relaxation**: raw paths still `bad_attachments`.
4. **Reuse**: feishu already uploads via `/api/upload`; agents gain a first-class tool instead of bash+curl.

## Surfaces
| Surface | Tool | Path validation |
|---------|------|-----------------|
| Claude SDK MCP | `upload_file` (local handler) | yes |
| Grok ACP | stdio MCP `commhub_upload` → `upload_file` | yes |
| node-server | `commhub_upload_file` | yes |
| Hub MCP | unchanged (no path-based upload) | n/a |
| Hub HTTP | existing `/api/upload` | n/a (bytes only) |

## Controlled roots
- `~/.anet/cache/attachments/<alias>`
- `~/.grok/sessions`, `~/.grok/images`
- `/work/feishu-attachments`, `ANET_FEISHU_MEDIA_DIR`
- `ANET_UPLOAD_ROOTS` (operator allowlist)
- `ANET_NODE_DIR` when set
- cwd only if under `~/.anet` or `~/.grok`

## Hard rejects
symlink leaf, non-regular file, outside roots, empty, >12 MiB, missing auth/hub URL, hub response without valid `file_id` (never fall back to path).

## Atomicity (#693 hub tweak)
Upload writes blob to `.tmp`, writes index, then `rename` to final path; index/blob cleaned on failure.
