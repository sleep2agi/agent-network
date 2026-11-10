# Original frontdoor docs fixture

`run.mjs` checks the existing bilingual source, builds the actual VitePress site,
and checks rendered homepages and download routes. PR2613 archived the historical
upgrade note at `docs/archive/upgrade-v2.md`; the historical-disclaimer assertion
now reads that authoritative input. No original assertion is removed.

Build the digest-pinned Node22 Dockerfile with a full `SOURCE_COMMIT`. Run
`node tests/qa-frontdoor-docs/controls.mjs` inside a fresh container for each
`FIXTURE_CASE=baseline`, `old-path`, and `missing-note`, setting
`EXPECTED_SOURCE_COMMIT` to that exact input SHA. The baseline executes the
complete original suite and production build. The two negatives execute the
same script after restoring the exact missing old path or deleting the actual
disclaimer, require its specific original failure, and restore both inputs
byte-for-byte. A failed baseline or false-green control fails the workflow.

The independent `.github/workflows/frontdoor-docs-fixtures.yml` stores the whole
text report. Cases use separate containers with no network or host state mounts;
this does not prove live website deployment, current installer availability,
other runtime/lifecycle suites or full production recovery.

Recovery scope: this fixture starts no resident service and needs no runtime
secret. Production service launchers, proxy/port mappings, secret sources,
version activation and rollback remain in the existing `deploy/`/`ops/` and
deployment guides; they are not changed here. Clone the exact software SHA,
build this locked-input image, and run the original suite to verify this scope;
revert the fixture commit to roll its software back. Git restores test code and
historical documentation, not production databases, registration identities,
credentials or history, which still need their authorized backup sources.
