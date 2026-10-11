# One-off exact CLI .165 release claim probe

Verified: 2026-10-11
Revisit-when: Integrating a recurring artifact-producing workflow, or retiring the probe after formal release evidence supersedes these incident checks.

This is an incident/release-owner probe of the TEST-ONLY tarball produced by
run38128894984. The artifact must be downloaded into a read-only Docker mount;
a regular source CI checkout cannot supply that exact tarball. It intentionally
defaults to .165; an explicit EXPECTED_CLI_VERSION selects the exact incident
artifact (currently also .166). Its package-version assertion remains exact,
and all password/idempotence assertions are unchanged. It is not a recurring
source regression matrix entry.

The shared image can be rebuilt using the locked Dockerfile referenced in this
suite's Dockerfile. The report in docs/tests/report-test906-cli165-doc-release.txt
records the three actual package assertions and the synthetic HTTP scope.
Formal release.yml still performs the actual installation smoke and version
claim gate for every release. This exemption does not remove any existing guard,
change the orphan baseline, or permit publication of the failed-gate artifact.
