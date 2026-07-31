# One-shot installer retired

::: danger Do not run an old copy of `setup-anet.sh`
The old script had no reproducible end-to-end verification and used broad process
cleanup plus recursive state deletion that could affect unrelated services on the
same host. It also used an unsafe network default and secret-forwarding method.
:::

## Current status

`https://anet.sh/setup-anet.sh` remains available for old bookmarks, but now only
prints a retirement notice, makes no system changes, and exits non-zero.

Do not run a previously downloaded or copied version, even for a “clean reinstall”
or “cache cleanup.” Its cleanup scope was not limited to this installation and
could stop other Agent Network processes or delete npx code and state still in use.

## Supported alternatives

- Local evaluation: [30-second quickstart](/en/guide/getting-started)
- New server: [fresh-server deployment](/en/deploy/clean-server)
- Production: [public-internet security](/en/deploy/production)
- Multiple nodes: [batch agents](/en/guide/batch)

These paths separate installation, authentication, network binding, node creation,
and verification, so a failure can be traced to one step.

## Why it was not patched in place

A safe rewrite needs redesigned process ownership, credential forwarding,
idempotent recovery, and uninstall boundaries, followed by reproducible E2E on
clean Ubuntu/Debian environments. Until that exists, an unverified one-shot script
is not a supported entry point.
