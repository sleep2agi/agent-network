# Current task counts by tag and status

Hub138 extends `GET /api/requirements/stats` with `tag_status`. Requirements
lists advertise the `tag_status_snapshot` capability. Consumers should detect
this extension independently of the existing `stats` completion-history fields.

The endpoint resolves the network and task visibility before reading the full
light-row set. `tag_status.complete: true` means all tasks visible to that caller
in the selected scope were counted, without a client page/500-item limit.
`basis: "current"` and `includes_archived: false` distinguish this snapshot from
the time-based completion totals, which retain their historical semantics.

Optional `project_id` filters both the snapshot and existing stats fields.
Omit it (or send empty) for all visible projects; `none` selects tasks with no
project. Unknown or invisible projects return an empty result, without probing
other networks. Oversized/control-character values return `invalid_project_id`.

```json
{
  "tag_status": {
    "basis": "current",
    "complete": true,
    "includes_archived": false,
    "project_filter": null,
    "total": 2,
    "by_tag": [
      {"tag": "ANet", "pool": 1, "doing": 1, "done": 0, "abandoned": 0, "total": 2},
      {"tag": "知识库", "pool": 1, "doing": 0, "done": 0, "abandoned": 0, "total": 1}
    ]
  }
}
```

Here the pool task has both labels and the doing task has ANet only. Each
distinct label receives one membership per task, so the sum of tag totals can
exceed the unique task count in `total`. Repeated labels on one task are
deduplicated. A `tag: null` bucket represents unlabeled tasks and remains distinct
from a literal label such as `无标签`. Invalid stored legacy tag JSON falls back
to unlabeled. Each bucket includes pool/doing/done/abandoned, including zeroes.
Buckets sort by pool+doing descending, then total descending and label.

`project_filter` is null for all projects, `none` for no project, or the supplied
project id. Completion `from`/`to` and the daily timezone do not limit this current
snapshot; a task currently done counts even outside the completion period.

Client delivery remains separate: parsing, desktop/mobile stacked charts and
click-to-filter must preserve scope and distinguish the full snapshot from
partial old-Hub loaded data. A Hub lacking this field must not be reported as a
complete tag snapshot. This contract does not add or enable the client UI.
Software publication does not activate the managed Hub, which remains137 until
an independently authorized upgrade. No schema, credentials or daemon changes.
