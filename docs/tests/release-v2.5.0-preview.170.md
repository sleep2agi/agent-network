# agent-node 2.5.0-preview.170

Since `.169`: the node reports its **build commit** alongside its version label.

## Behaviour

- `report_status` (both the startup report and the periodic heartbeat) now carries
  `build_commit` when a `build-info.json` is present in the install.
- That file is written at **package time** (`prepack`): it prefers `GITHUB_SHA`, falls back to
  `git rev-parse`, and **writes nothing** when neither is available — an npm install tree has no
  `.git`, and a fabricated commit is worse than an absent one.
- Read-side validation is strict (`schema: 1`, 40 lowercase hex, boolean `dirty`, ISO-8601 `Z`
  timestamp). A corrupt file yields *no* value rather than a wrong one; the reason is surfaced by
  the Hub's `build_note`, not invented here.

Old Hubs silently drop the unknown top-level key, so this release is safe to ship before the Hub
that reads it.

## What this does not claim

A node still running `.169` reports no build commit at all — absence is the normal state for older
installs, not a defect.

## Verification

- `src/build-info.test.ts` — 4 pass (three states + strict validation).
- `src/runtime/config-apply.test.ts` — 114 pass (the report paths are unchanged otherwise).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.170
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.205 @sleep2agi/agent-node@2.5.0-preview.170
```
