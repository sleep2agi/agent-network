# CommHub v0.9.0-preview.237

Built from main at `3f6822d69`.

## What changed

**One error-code mapping in the provider write path no longer blames the caller.**

`providerWriteStatus(code)` used to accept any string and fall back to **400** for a code it did not
know. Two things were wrong with that:

- Taking `string` discarded the exhaustiveness of `Record<ProviderWriteErrorCode, number>`: adding a
  code to the table without a status entry was invisible at the call site.
- A code missing from the table is *our* defect, not a bad request. Reporting 400 tells the client to
  fix something that is not broken — the attribution lands on the wrong party.

Now the parameter is the closed union, the fallback is **500**, and a test walks every listed code
asserting `statusOf(code) === STATUS[code]` plus a mirror assertion that an unlisted code maps to 500
and never 400.

Migration: none. No route, table or response shape changed; only the status code of a
programming-error path.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.237`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.237
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.237
```

## Rolling back

`0.9.0-preview.236` behaves identically except that an unlisted error code would surface as 400
instead of 500.

Do not overwrite published packages.
