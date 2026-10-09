# One-off coordinated version candidate gate

Verified: 2026-10-09
Revisit-when: Reusing this gate for another release or making its cached native/client dependency inputs available to clean CI; then parameterize versions and register it in the relevant workflow and paths, or retire it after the candidate's formal release gates replace it.

This suite is deliberately run by the #539 release owner during preparation of
Hub .120 / runtime .128 / CLI .162. It hardcodes that candidate and depends on a
local integration image containing the real V2 binary, current Web export and
native harness. Standard GitHub runners cannot resolve that image. Adding its
name to a CI matrix would not create a reproducible dependency chain.

Exact source, image digests, commands, initial environment failure and successful
Docker runs are recorded in `docs/tests/report-test539-release-candidate.txt`.
This exemption does not exempt the PR from existing version, pairing, Docker
E2E or documentation checks, nor any formal `release.yml` artifact gate. Branch
images are test-only. The full40 main-SHA build/publication gate remains required.
