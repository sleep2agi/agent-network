# One-off exact CLI .165 release claim probe

Verified: 2026-10-11
Revisit-when: Reusing this probe for another CLI release; parameterize its artifact version and integrate the artifact-producing workflow, or retire it after the formal release evidence supersedes this incident probe.

This is an incident/release-owner probe of the TEST-ONLY tarball produced by
run38128894984. The artifact must be downloaded into a read-only Docker mount;
a regular source CI checkout cannot supply that exact tarball. It intentionally
hardcodes .165 and is not a recurring source regression matrix entry.

The shared image can be rebuilt using the locked Dockerfile referenced in this
suite's Dockerfile. The report in docs/tests/report-test906-cli165-doc-release.txt
records the three actual package assertions and the synthetic HTTP scope.
Formal release.yml still performs the actual installation smoke and version
claim gate for every release. This exemption does not remove any existing guard,
change the orphan baseline, or permit publication of the failed-gate artifact.
