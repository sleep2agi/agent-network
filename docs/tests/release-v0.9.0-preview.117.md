# CommHub v0.9.0-preview.117

Release preparation only; not evidence of npm publication or production
deployment. Publish to preview only, never move latest.

## Included Hub change

Compared with .116 main commit `8aa112eae991434a15dc78a9bdea25c1950857d2`,
this release includes #2525, merged as
`a625706e1365a65255ab36739ed8f8147fc7f495`:

- Node-only MCP `org_whoami` returns the authenticated node's independent
  Agent team, ancestor teams, Agent lead, visible human owner and teammates.
- No human-department fallback. Missing membership is explicitly empty.
- Identity comes from the authenticated node, not an alias supplied in input;
  network and node visibility rules remain enforced. Teammates are capped at
  50 with a truncation flag. Human credentials cannot call this tool.

Existing REST interfaces and request fields are unchanged. No schema migration,
new background job, CLI update or agent-node update is included in this Hub
release. The new-member scoped-access policy from .116 remains unchanged.

## Validation

The feature PR passed all 157 checks and the standalone merge gate before
merge. Its actual HTTP tests covered SQLite and PostgreSQL, identity isolation
and mutation checks. Release compatibility results are recorded separately in
`report-hub117-compat.txt`; PR and release gates remain required.

The release replay seed explicitly creates a full-access existing member rather
than depending on the baseline's default. A separate unchanged request without
task_access still verifies that newly added members default to scoped access.
This adjusts test setup, not Hub behavior or visibility assertions.

## Install

After publication, install the exact version in the intended environment:
`npm install -g @sleep2agi/commhub-server@0.9.0-preview.117`.
Do not run global installation on a shared development host for testing.

## Upgrade

Follow the existing deployment runbook: back up the database, install the exact
package in a replacement runtime, switch the launcher, and verify the actual
running version and health. Package installation alone does not switch a live
Hub. This PR performs no production upgrade and changes no launcher, port,
proxy, tunnel or credential source. Data recovery still requires the existing
database backups; npm packages do not contain production data.

Rollback to .116 removes org_whoami; no new schema needs reversal. Do not roll
back across the existing token-issuance security boundary or mix historical
Hub issuers against the same database.

## Publication

Only dispatch release.yml after this PR merges, with the full 40-character
main SHA, package commhub-server, version 0.9.0-preview.117, publish=true.
Confirm no other release.yml run is queued or running first. Verify the npm
tarball and an isolated installation afterward; registry propagation delay
does not justify republishing or changing the version number.
