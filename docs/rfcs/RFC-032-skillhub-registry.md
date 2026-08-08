# RFC-032 — Network-scoped SkillHub registry

Status: implementation candidate

## Goal

Give agents and Dashboard users one place to submit reusable `SKILL.md`
knowledge. A submission is not executable code and is not published
automatically: it is an immutable text snapshot awaiting network review.

## Trust and tenancy

- Every row is scoped by `network_id`; reads and writes use the existing MCP
  membership/token scope helpers.
- A node cannot supply its own author identity. For `ntok_` callers the source
  alias comes from the authenticated token binding. User submissions use the
  authenticated user principal.
- New submissions always enter `pending`. Only a network `owner` or `admin`
  can publish or reject them. Ordinary members and nodes see published rows
  only; pending rows return `skill_not_found` to avoid metadata disclosure.
- `(network_id, slug, version)` is immutable. An identical retry is
  idempotent; different content under the same version is rejected.
- `SKILL.md` content is UTF-8 text capped at 128 KiB. Skill execution and
  installation are deliberately out of scope for this first module.

## Interfaces

MCP tools:

- `submit_skill` — nodes or writable members submit a version.
- `list_skills` — published list; reviewers may request pending rows.
- `get_skill` — fetch a single text snapshot under the same visibility rule.
- `review_skill` — owner/admin publishes or rejects a pending row.

Dashboard `/skillhub` calls these tools through its authenticated server-side
proxy. Browser code never receives a Hub token.

Example node submission:

```json
{
  "name": "submit_skill",
  "arguments": {
    "slug": "incident-handoff",
    "name": "Incident handoff",
    "description": "Create a concise, verifiable incident handoff.",
    "version": "1.0.0",
    "content": "# Incident handoff\n\n..."
  }
}
```

The server ignores any attempted author fields because none exist in the tool
schema. The response reports the token-bound source and `pending` status.

## Compatibility and rollout

The schema is additive and existing APIs are unchanged. Dashboard detects an
older Hub and reports that the SkillHub backend is unavailable instead of
showing fake success. Rollout order is Hub first, Dashboard second, then one
real node upload and reviewer publish UAT.
