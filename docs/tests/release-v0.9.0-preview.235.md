# CommHub v0.9.0-preview.235

Built from main at `6e232b6fa` (contains `cb7b55c2c`).

## What changed

**Runtime behaviour change (one route, one new state):**

- `GET /api/nodes/:id/provider-selection` no longer folds an unrecognised daemon status into
  `applied`. The mapping is now an explicit closed set:

  | daemon status | reported state |
  |---|---|
  | `pending` | `pending` |
  | `succeeded` | `applied` |
  | `failed` | `failed` |
  | `expired` | `failed` |
  | anything else | **`unknown`** (+ `observed_status`, + hint) |

  Why it matters: the previous fall-through made *every* status a future daemon might add read as
  "the switch already took effect" — the only folding direction that actively misinforms the user.

- Clients should treat `unknown` as "neither applied nor failed". Unknown values are echoed in
  `observed_status` instead of being guessed.

Also in this release (tests only, no runtime effect): the provider-selection fixture now uses a
status value the producer actually writes (`succeeded`), and two files document their local
environment-dependent failures with a reproduction of the pre-change reading.

Migration: none. Existing rows are unaffected; a row with a status outside the closed set now reads
`unknown` instead of `applied`.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.235`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.235
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.235
```

No schema change. Behaviour change is limited to one read route (see the table above); a Hub that is
not serving clients on `GET /api/nodes/:id/provider-selection` behaves identically.

## Rolling back

`0.9.0-preview.234` differs only in the provider-selection state mapping; roll back to it if any
client depends on the old (inaccurate) `applied` fall-through.

Do not overwrite published packages.
