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
