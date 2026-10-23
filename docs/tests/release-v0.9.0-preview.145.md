# CommHub Server — avatar upload ships, v0.9.0-preview.145

Ships `main` after #2898 (avatar upload hardening) and #2902 (exact refusal
code projection). This is the first published Hub that contains the account
avatar upload endpoint, so the client's "我的头像 → 上传本地图片" actually
works against a Hub from this version on.

```
@sleep2agi/commhub-server@0.9.0-preview.145
```

## What changed

- **Account avatar upload** (`POST /api/auth/me/avatar/upload`, user token only,
  multipart field `file`, PNG ≤512px / ≤8 MiB, atomic replace) and a
  visibility-scoped read (`GET /api/users/{id}/avatar/{version}.png`, private,
  no-store, not-visible and not-found both 404). Clearing or replacing an avatar
  revokes the previous hosted image in the same transaction.
- **PNG validation is strict**: chunk CRC-32, legal IHDR combinations, PLTE for
  palette images, real zlib decode with exact scanline length, filter bytes
  0..4, and **any non-zero interlace value is rejected** (`interlaced_unsupported`).
- **Rate limit before parsing**: the upload path counts requests before reading
  multipart, so a flood of bodies cannot bypass the 60/hour gate.
- **Lifecycle projection**: `copresence_adopt_v2` is now passed through as its
  own public code instead of degrading to `lifecycle_error` (#2902).
- **Session control relay** (#2890 / #2017): `POST /api/node-session-control`
  with `operation: state|background`, a short-TTL single enqueue, an `expected`
  identity (`session_id` + `binding_id`) and a read-only receipt poll. This is
  what the desktop client's 「读取状态 / 转到后台」 calls; it relays to the
  original node through the Bridge token, never sends keys, commands or URLs.

## Verification

- Server avatar suites: `user-avatar-upload-http` 4/0 (142 expect),
  `user-avatar-http` 1/0, `avatar-validate` 23/0, `user-avatar-migration` 1/0.
- `tests/test833-user-avatar` Docker suite on the merged tree: build/run exit 0,
  every file 0 fail.
- `node-lifecycle-read-http` 14/0 (497 expect) on the merged tree.

## Notes

- Bundled/pinned Hubs older than this version will answer 404 for the upload
  route; the desktop client now shows the HTTP status in the error text so
  "avatar didn't change" is diagnosable instead of silent.
- No database migration is required beyond the tables this release already
  creates (`user_avatar_uploads`).

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v145-preview145"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.145
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`).
The database file is shared. This release adds no table.

## Upgrade / rollback

`anet hub start` lazily fetches the `preview` dist-tag through bunx, so the running
Hub keeps whatever version it started with until it is restarted:

```bash
# 1) confirm the published tag
npm view @sleep2agi/commhub-server dist-tags
# 2) restart so bunx picks .145 up
anet hub stop && anet hub start
# 3) check the version actually running
bunx @sleep2agi/commhub-server@preview --version
```

If step 3 still prints `.144`, bunx cached the old tarball:
`rm -rf ~/.bun/install/cache/@sleep2agi/commhub-server*` and restart again.

Rollback = start the previous directory/version against the same `COMMHUB_DB`;
this release adds no table, so no data migration to undo.
