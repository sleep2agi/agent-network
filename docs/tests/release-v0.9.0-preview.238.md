# CommHub v0.9.0-preview.238

Built from main at `71211a98e`.

## What changed

**Every hub response now carries a constant producer marker: `X-CommHub: hub`.**

Behind a reverse proxy the bytes a client receives are not always ours — a proxy's 502/504 page is
HTML, and a client that only checks `content-type` has to remember to do that first. With a constant
marker the distinction is mechanical: header present ⇒ this response was written by the hub; header
absent ⇒ it came from a layer in front of it.

The value is a fixed string. It never varies by process, version or request, so it cannot act as a
fingerprint (contrast `version_role` / `git_commit`, which answer "which build am I talking to" and
therefore stay out of the anonymous projection).

Also in this release (no behaviour change): `/health` field metadata gains `stable_within`
(`request | process | deploy`) and a test asserts that within a declared 1200 ms window every
`frozen_at_boot` field is byte-identical across two reads, plus the mirror that something else in the
same window must change.

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.238`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.238
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.238
```

## Rolling back

`0.9.0-preview.237` behaves identically except that responses carry no `X-CommHub` header; clients that
started relying on it would see "written by something in front of the hub" for every response.

Do not overwrite published packages.
