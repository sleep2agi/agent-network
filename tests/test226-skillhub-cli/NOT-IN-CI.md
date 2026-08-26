# NOT-IN-CI

Verified: 2026-08-27
Revisit-when: SkillHub CLI needs an always-on CI contract, or the suite is made
fast enough for L1 without cold Docker dependency installs.

`test226-skillhub-cli` is a focused witnessed-red suite for the SkillHub CLI.
It builds a Docker image, starts a local HTTP catalog/content fixture, and
proves that a mismatched `content_sha256` is rejected while an unverified
baseline would accept the same bytes.

It is intentionally not part of the default CI L1 set because it performs a
cold Docker dependency install and exists as a manual release/regression proof
for the SkillHub download/cache/verification path, not as a fast always-on
contract test.
