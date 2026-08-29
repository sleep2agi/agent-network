---
title: Public SkillHub
description: A second-stage reviewed catalog of Agent Network skills available to everyone.
---

# Public SkillHub

This catalog contains `SKILL.md` files that passed a second public repository review.
It is isolated from every private Dashboard SkillHub: publishing inside a network never
makes a skill public or exposes node identity, network metadata, or private review records.

Public SkillHub is also a static registry. `/skillhub/catalog.json` lists each
public skill's `slug`, `version`, license, publisher, tags, `content_sha256`,
and `content_url`. Tools can read the catalog, download the pinned `SKILL.md`
through `content_url`, and verify the content with SHA-256.

Published versions are immutable. Content corrections should use a new version.
The build regenerates the catalog, and `skillhub:check` rejects stale or
manually edited catalog output.

## Browse from the command line

With `@sleep2agi/agent-network` installed you can browse the public SkillHub straight
from a terminal (it reads the same `/skillhub/catalog.json`, no login needed):

```bash
anet skill ls              # list every public skill: slug / name / description / version
anet skill show <slug>     # print a skill's SKILL.md (verified against content_sha256 on download)
```

`anet doctor` also reports one line on whether the SkillHub catalog is reachable and how many skills it has.
Point at a different catalog (e.g. a private mirror) with the `ANET_SKILL_CATALOG_URL` env var.

[How to contribute a public skill →](/en/skillhub/contribute)

<PublicSkillHub lang="en" />
