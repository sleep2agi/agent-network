# RFC-033 — Private and public SkillHub planes

Status: implementation candidate

## Product boundary

SkillHub has two separate trust planes. They intentionally do not share a
database or a meaning of “published”.

| Plane | Audience | Source of truth | Review authority |
| --- | --- | --- | --- |
| Private SkillHub | Members and nodes of one Agent Network | That network's Hub database | Network owner/admin |
| Public SkillHub | Everyone visiting `anet.sh` | Reviewed files in the public `agent-network` repository | Public repository maintainers |

`published` in the private plane means **network-published**, not public on the
Internet. No private row is copied, indexed, or exposed by anet.sh
automatically.

## Promotion flow

1. A node or member submits an immutable `SKILL.md` to its private network.
2. A network owner/admin reviews it and makes it network-published.
3. A reviewer explicitly exports a public-submission bundle from Dashboard.
4. The bundle omits `network_id`, node IDs, user IDs, token-bound aliases,
   review notes, and internal audit data. It includes only public metadata,
   content, a declared license, and a content hash.
5. A human opens a pull request that adds the bundle under
   `docs-site/docs/public/skillhub/skills/<slug>/<version>/`.
6. Repository CI validates the bundle. A repository maintainer performs the
   second review and merges it. Only then does it appear on anet.sh.

This is deliberately a two-review process. A private network owner is not a
global public-catalog moderator, and a node token can never publish directly
to the public plane.

## Public registry format

Each immutable public version contains:

```text
docs-site/docs/public/skillhub/skills/<slug>/<version>/
├── metadata.json
└── SKILL.md
```

`metadata.json` contains only:

- schema version;
- slug, display name, description, and version;
- SPDX license from the accepted allowlist;
- public publisher name and optional public URL;
- public tags and publication date.

The build produces `docs-site/docs/public/skillhub/catalog.json` with a
SHA-256 digest and content URL for each version. The generated catalog is
deterministic and checked into the repository so review shows the exact
public result.

Changing content under an existing `(slug, version)` is forbidden by policy.
Corrections use a new version. Git history supplies the public audit trail.

## Validation and rendering

The validator fails closed on:

- invalid or mismatched slug/version paths;
- duplicate `(slug, version)` entries;
- unknown metadata fields or unsupported licenses;
- symlinks, unexpected files, NUL bytes, oversized content;
- credential-shaped strings, private keys, and host-local home paths;
- a stale or manually edited generated catalog.

anet.sh renders `SKILL.md` as plain text, never as raw HTML. Public reads need
no token, cookie, or access to a private Hub. Search happens in the browser
over the static catalog.

## Dashboard export contract

The private Dashboard export action is available only for a
network-published skill to a network reviewer. Export is not publication and
must say so in the UI. The browser builds the bundle from the already
authorized detail response and downloads it locally; no private Hub token is
placed in the file or sent to anet.sh.

The default license is not inferred. The reviewer must select one of the
public allowlist values before export.

## Future federation

A future `submit_public_skill` API may replace the pull-request upload step,
but only after anet.sh has a publisher identity system, abuse controls,
central moderation, immutable artifact storage, and a transparent audit log.
It must preserve the explicit export and second-review boundary above. A
self-hosted Hub must never gain ambient write access to the public catalog.

