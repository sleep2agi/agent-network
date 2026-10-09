# Human profile avatar — first backend slice

Tracking: [client issue 781](https://github.com/sleep2agi/agent-network-app/issues/781), Hub #833.
This is not the Agent/node avatar and is not yet a client release.

`PUT /api/auth/me/avatar`, authenticated with the current user's Bearer token:

```json
{"avatar_url":"/avatars/avatar-03.webp"}
```

Success returns `ok`, authenticated `user_id`, and normalized `avatar_url`.
Use `null` to restore the default. The existing avatar URL validator also allows
absolute HTTP(S) links, rejects credentials, hostile schemes and arbitrary
relative paths. The Hub stores the reference and does not fetch remote images.
Clients should disclose that a remote image host receives image requests.
Local file paths/data URLs are not uploads. Photo selection/upload is a separate,
unfinished slice; do not show it as available based on this API.

Only a user credential may write. A node credential cannot act as its human
owner. Caller-supplied IDs and unknown fields are rejected. GET `/api/auth/me`,
login responses and the existing authorized network human/member directory
return `avatar_url`; their existing visibility checks still apply. Clients must
key by Hub + user ID, not an alias shared with nodes. User avatars are profile
attributes shared across that user's networks on the same Hub.

The separate write route allows old Hubs to report unsupported rather than
silently ignoring a new field in their profile PUT. A client must confirm `ok`
and the saved value, retain the old avatar on failure, and clear per-account
state on account/Hub switch.

## Operations and recovery

- No new process, port, proxy, environment variable, secret, or storage directory.
  Existing Hub startup/deployment remains unchanged.
- Startup adds nullable `users.avatar_url` if absent. Existing rows default to
  null; no identity/token/password changes. Launch using the existing Hub entry
  point `server/bin/commhub.ts` and existing deployment configuration.
- Upgrade only from a reviewed exact main SHA. Verify save → GET → second login
  → member directory → clear with authorized test accounts in isolation first.
  The Docker suite does not modify a production Hub.
- Roll back the binary to the prior recorded deployment SHA; leave the additive
  column in place. Old binaries ignore it. Never drop user data during rollback.
- Avatar references live in the existing SQLite database: restore them from the
  Hub's existing encrypted data backup, not Git. No new backup/secret source is
  introduced. Linked external image bytes are not backed up by this feature.
- Docker verification: `sg docker -c 'docker build -f
  tests/test833-user-avatar/Dockerfile -t anet-test833 . && docker run --rm
  --network none anet-test833'`. This is a backend contract test, not a full
  empty-server recovery drill or desktop/mobile acceptance.
