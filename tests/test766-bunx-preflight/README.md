# test766 — Bun package-runner preflight

Commits the three behavioral cases chosen by #767:

1. `bun` exists and `bunx` does not: fail before spawn with the precise
   remediation message;
2. neither exists: retain the generic Bun installation message;
3. `bunx` exists: cross the preflight, preserve the exact package argv, and
   reach the CLI's healthy-Hub banner.

Two witnessed-red mutations restore the old permissive OR and make the guard
reject a valid bunx installation. This suite is listed in `scripts/qa.sh` L1;
it is not an uncalled local probe.

The healthy-path HTTP fixture covers CLI wiring and does not claim to replace
the repository's real commhub-server E2E suites.
