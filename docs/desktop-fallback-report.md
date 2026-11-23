# Desktop fallback report-only

`desktop-fallback-report.yml` is a manually dispatched, read-only evidence collector.
After it is merged, dispatch it on **main**, supplying the fallback PR number before
human merge. It checks out the exact main workflow commit, never PR code, and uses
the existing `GITHUB_TOKEN` with read permissions. It cannot merge or change branch
protection. No new credentials are required.

Download the `fallback-report-<run>-<attempt>` JSON artifact. A green workflow only
means collection finished; inspect `result.decision` and every reason. Setup or
collection failures produce a manual report. Artifact retention is 30 days; retain
release acceptance evidence separately for the three-release observation ledger.

Creation provenance now checks the generation artifact digest/content, exact run
identity, main ancestry and producer code blobs. Required-check policy is read from
classic protection and effective rules, then rechecked at collection end. Currently
only the two existing lint contexts bound to GitHub Actions app 15368 are supported;
unknown contexts or effective rules remain manual. Check producers must bind to the
exact PR/head/base, approved lint workflow ID/content and fallback-only file scope.
Positive end-to-end GitHub acceptance is still pending: historic 614 has no generation
artifact and an outdated base, so it correctly remains manual. Skipped extra checks
have no approved allowlist yet and also require manual handling. If protection APIs
reject the existing token, the error remains evidence debt, not an empty policy.
Downloads bind exact release assets, lengths and SHA-256; minisign uses the updater
public key from the exact release source. This does not independently approve key
rotation or prove native installation, Authenticode, store submission or rollback.

The existing generator additionally emits `fallback-generation-<run>-<attempt>`
after a successful branch push, with full commit/parent/blob SHA, version, branch
and workflow/run identity. A no-change run emits no creation artifact. This closes
the short-SHA logging gap for future releases; the collector must still independently
verify the artifact's producing workflow and bind its contents to the current PR.
The record is provenance data, not approval or a replacement for the three-release gate.

The historic 614 PR replay does not count toward the required three consecutive
pre-merge eligible reports. Each future qualifying report also needs final merged
content and deployed-channel verification; missing or conflicting evidence resets
the count. Automatic merge remains disabled.

Local collection requires Node 22+, unzip, minisign on PATH (or `MINISIGN_BIN`), and existing
GitHub read access through `GITHUB_TOKEN`. Run from the repository root:

```sh
node docs-site/scripts/fallback-report.mjs 3823 fallback-report.json
```

Tests run in the isolated `tests/test-fallback-report/Dockerfile` image with network
disabled at runtime. `desktop-fallback-report-tests.yml` runs this suite for PRs
and main pushes with symmetric paths covering collector, tests and both workflows.
The collector also receives a syntax check during the image build. Tests cover
policy rejection and real minisign verification of
valid, corrupted and unavailable-verifier cases. Real-repository read-only rehearsal
is additionally required before merging changes to the collector.
