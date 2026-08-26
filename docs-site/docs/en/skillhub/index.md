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

[How to contribute a public skill →](/en/skillhub/contribute)

<PublicSkillHub lang="en" />
