Package README simplification report — 2026-07-31

Scope
-----
- agent-network/README.md
- agent-node/README.md

Outcome
-------
- agent-network README: 391 -> 78 lines.
- agent-node README: 211 -> 79 lines.
- Removed fixed npm/preview version tables, fixed OpenCode/model pins, repeated
  provider matrices, implementation narration, duplicated command catalogs,
  and status claims that drift independently from the published packages.
- Kept the install and first-run path, release-channel boundary, runtime status,
  token/config safety, task semantics, and canonical troubleshooting links.
- Kept the Grok boundary precise: grok-build-acp is published; shared Grok TUI
  is not in current npm packages. Source-only development work is not presented
  as an installable feature.

Deleted-detail routing
----------------------
- Full commands -> docs-site CLI reference.
- Runtime install/auth/permissions -> runtime and Agent Node guides.
- Provider endpoints/models -> multi-model guide, not a version-pinned table.
- Hub/LAN/security detail -> production and token/security guides.
- Grok/Codex co-presence detail -> their dedicated status/guides.
- Tool and state-machine internals -> task lifecycle and API references.

Verification
------------
PASS  git diff --check
PASS  independent Dockerfile source/static gate (anet-docs-readme:dev)
PASS  both READMEs are under 100 lines
PASS  no fixed preview, package, OpenCode, or model version remains
PASS  CLI source contains the documented preview upgrade path
PASS  package engines confirm Node >=22.13.0 and Bun >=1.2.0
PASS  source confirms TOOLS/SYSTEM_PROMPT configuration and token precedence
PASS  all eleven linked anet.sh documentation pages returned HTTP 200
PASS  npm dist-tags queried during audit; no returned version is copied into
      user-facing prose, so the README does not stale on the next release

Test policy
-----------
Documentation-only change. The Docker gate copied only the two READMEs and their
source/package evidence. It did not start a Hub, model runtime, npm publish,
production process, database, or user configuration, and consumed no model quota.
