---
title: Contribute to Public SkillHub
description: Export a reviewed private skill and submit it to the public anet.sh catalog.
---

# Contribute to Public SkillHub

Public contributions have two reviews: a network owner/admin first publishes the skill inside
the private network, then public repository maintainers review it for the Internet catalog.
Private publication does not mean public publication.

## Submission steps

1. Open a network-published skill in the private Dashboard SkillHub.
2. Choose “Export public submission” and select an explicit open-source license.
3. Remove tokens, internal domains, personal paths, customer data, and private identities.
4. Fork [`sleep2agi/agent-network`](https://github.com/sleep2agi/agent-network) and import the bundle downloaded by Dashboard:

   ```bash
   node scripts/import-public-skill-bundle.mjs ~/Downloads/<bundle>.json
   ```

   The import creates:

   ```text
   docs-site/docs/public/skillhub/skills/<slug>/<version>/
   ├── metadata.json
   └── SKILL.md
   ```

5. Run `node scripts/build-public-skillhub.mjs`, commit the source files and updated `catalog.json`, and open a pull request.

Updates use a new version instead of replacing already published content.

## Data that is not exported

The Dashboard bundle omits network IDs, node IDs, user IDs, token-bound aliases, private review
notes, and Hub audit data. Export creates a local file and never sends it to anet.sh automatically.
