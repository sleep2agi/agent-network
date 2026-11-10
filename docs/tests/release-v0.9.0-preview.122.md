# CommHub 0.9.0-preview.122

Managed Codex account transport for #906. Candidate notes are not publication
or deployment evidence.

## Install

After publication: `npm install -g @sleep2agi/commhub-server@0.9.0-preview.122`.
Use the existing Bun-based [Hub launcher](../../deploy/hub/README.md).

## Upgrade

Back up the database using the existing deployment procedure; activate this
exact package and verify the running Hub version and authenticated managed-login
API. Then upgrade the selected daemon to CLI 2.3.0-preview.164 and runtime
2.5.0-preview.130. Installing software does not switch an existing process.
The Hub transports scoped login requests and public receipts; private account
credentials remain on the owning daemon. Real login requires the account holder.

## Rollback and recovery

Reconcile or cancel outstanding login and application requests before restoring
the retained .121 software. Software rollback does not roll back account custody
or credentials that may have rotated. Restore Hub data only through the existing
encrypted backup procedure; the daemon account vault and journals need their
own protected backups or fresh sign-in. Keep ownership and request history.
Startup, proxy/ports, secret sources and rollback remain in the existing Hub
deployment guide; no new persistent service or port is introduced. See the
[managed-account design](../design/906-daemon-provider-management.md).

## Evidence and publication

The [core report](report-test906-managed-login-core.txt) records native Codex with
synthetic accounts and a container-local HTTPS peer, not real OAuth or remote
model entitlement. Publish only a fresh full40 main-SHA build through release.yml;
verify registry bytes before deployment and before pinning the client sidecar.
Keep latest unchanged. Git alone does not recover production data.
