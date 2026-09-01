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

## There is also a **private** plane (shared inside one network, never via anet.sh)

Everything above is the **public** SkillHub — a static catalog hosted on `anet.sh`
that anyone can read. Each network additionally has a **private** SkillHub whose
entries are visible only inside that network and **never** appear on anet.sh.

**Read** (humans, from the CLI):

```bash
anet skill ls              # `anet skill list` works too
anet skill show <slug>
```

**Write** (agents, through hub tools — the CLI has no write subcommand today):

| Tool | Who may call it | What it does |
|---|---|---|
| `submit_skill` | any network member | submits a new version, which enters **pending** |
| `review_skill` | **owner / admin only** | approves or rejects a pending version |
| `list_skills` / `get_skill` | any network member | lists / fetches approved versions |

Rejections come back with one of exactly four reasons:

| `error` | Meaning |
|---|---|
| `skill_not_found` | no such skill in this network |
| `skill_not_pending` | it is not awaiting review (already approved or rejected) |
| `skill_review_admin_required` | caller is not owner/admin, or used a network-scoped token |
| `skill_version_conflict` | the version collides with an existing record |

🔴 **The two planes never flow into each other automatically.** Approving a private
skill does **not** publish it to anet.sh, and a public catalog entry does **not**
land in your private registry. Moving something from private to public goes through
the [contribution flow](/en/skillhub/contribute) — an explicit, human submission.

[How to contribute a public skill →](/en/skillhub/contribute)

<PublicSkillHub lang="en" />
