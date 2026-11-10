# CommHub 0.9.0-preview.136

Password changes can optionally revoke the caller’s named network tokens with `revoke_network_tokens: true`. Without the option, those tokens remain valid and their metadata is returned in `kept_network_tokens`. `revoked_network` contributes to the aggregate count. Node credentials and other users are preserved; `keep_cli_tokens` remains independent. Password update and revocations commit together.

## Install

```bash
npm install --prefix <managed-prefix> https://github.com/sleep2agi/agent-network/releases/download/commhub-server-v0.9.0-preview.136/sleep2agi-commhub-server-0.9.0-preview.136.tgz
```

## Upgrade

Install the same exact version into an inactive managed prefix and follow `deploy/hub/README.md`: verify main-built public artifact bytes/SRI, private consistent database backup and offline schema preflight before activating the selected Hub. Keep the prior prefix for rollback. Git records software/profile/lock; private data and original secret values require their existing private sources. Complete key recovery remains NOT_COVERED.

The option is available through the documented HTTP password endpoint; CLI and Dashboard controls are separate follow-up interfaces. Source Docker results are recorded in `report-test717-password-network.txt`; source CI, main publication and actual selected Hub activation are separate gates. This candidate does not claim the staged CLI173 or production Node139 activity canary complete.

Source/main and prepared deployment evidence is recorded in `report-test717-hub136-publication.txt`. All four formal gates, npm publish and metadata verification passed. Registry tarball GET still returned404, tracked separately; use the exact same verified-main GitHub package URL above. Selected Hub136 is active after complete public-byte comparison, backup and offline preflight. Original Node139 activity canary remains separate.

Late npm distribution verification2026-10-13T06:03:47–48Z:exact-version npm installation is available again; preview tags and complete tarball bytes/SRI match the original main-built artifacts. Existing GitHub download/managed lock stays valid. Preserve the historical CLI timeout and keep the original Node139 activity canary separate.
