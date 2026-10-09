# ANet CLI 2.3.0-preview.162

Release candidate for Issue #2544 / Hub #539. Not publication, client package
delivery or production deployment evidence.

## Included changes

The exact CLI/runtime pair advances to .162 / agent-node .128. Stored V2
copresence mode dispatch, explicit generation/unsafe consent, launch-generation
proof and bounded graceful-stop cleanup are included from the merged delivery
slices. V1 remains the default; denied V2 starts must fail before unsafe launch.
No automatic model change, fork, adoption or bulk restart is introduced.

## Install

After Hub .120, runtime .128 and CLI .162 have each been published and verified:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.162 @sleep2agi/agent-node@2.5.0-preview.128
```

## Upgrade

First activate and verify Hub 0.9.0-preview.120 using the existing deployment
runbook. Install the exact pair above and update the intended daemon's real CLI
pin/path through its existing procedure. A package installation alone does not
replace the running daemon. Restart only authorized targets, then check running
versions, capabilities, request-specific launch evidence and actual task output.

PINNED_SERVER_VERSION remains the existing published compatibility floor, not
the registry channel's default version. It is not raised to an unpublished
candidate. Remote V2 creation nevertheless needs the compatible running Hub.
V2 requires independent trusted @opencode/cli 2.0.22 installation and explicit
unsafe-tools consent; it is not a security sandbox or V1 in-place upgrade.

## Rollback

Drain/reconcile pending V2 requests, stop new V2 nodes, then restore CLI .161
and runtime .127. Preserve private config, external runtime bindings and Hub
request history from existing encrypted backups. Do not convert V2 sessions to
V1 or restore old launch evidence as current health. See
[the runtime runbook](../runbooks/opencode-tui-copresence.md).
No new service, port, proxy, tunnel or secret source is introduced.

## Validation and publication

Backend #2551 and app #785 have merged after their exact-head gates; the app
requires its own fresh main-SHA package release. Linux browser/native runtime
tests do not establish native WebView, macOS/Windows or full model-change UI
acceptance. Version and artifact gates remain additional requirements.
Publish Hub, runtime, then CLI from a verified full40 main SHA after this
candidate merges. Rebuild rather than relabel branch images; verify published
metadata, tarball contents and behavior. Keep latest unchanged.
