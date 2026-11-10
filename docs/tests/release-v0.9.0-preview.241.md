# CommHub v0.9.0-preview.241

Built from main at `1813bee5`.

## What changed

**The two upload paths no longer each own a copy of the same rejection and rate-limit code.**

`POST /api/auth/me/avatar/upload` and `POST /api/upload` had, verbatim, their own
`earlyReject` closure (`withCors` + `Connection: close`) and their own 429 header builder
(`X-RateLimit-Limit` / `-Remaining` / `-Reset`). A header-producer count over `server/src` reported
each of those `X-RateLimit-*` names as having **two** write sites — meaning a change to one path was
half a change, and no test could notice the other half.

They now call a single `uploadEarlyReject(req, res)` and a single `uploadRateLimitHeaders(rate)`.
Behaviour is unchanged: the reject path is still `withCors` + `Connection: close`, and the 429 body
and header fields are byte-identical.

Producer counts afterwards: `x-ratelimit-limit` / `-remaining` / `-reset` **2 → 1**, `connection` 3 → 2.

Migration: none. No route, table or response shape changed.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.241`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.241
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.241
```

## Rolling back

`0.9.0-preview.240` behaves identically; the difference is only that the duplicated closures exist.

Do not overwrite published packages.
