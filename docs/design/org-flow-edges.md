# Org-flow edges: agent-to-agent dispatch contract

Status: **contract only**. Nothing here is implemented by this change. The 3D
legion page on the web dashboard still draws organization-hierarchy edges, and
the 2D org page in the App waits for admin sign-off before any code moves.

Consumers: the 3D legion topology (`https://dm.vansin.top/legion/3d`) and the
planned 2D org page in the App. Both ends must derive identical edges from the
same snapshot, so a viewer switching surfaces sees the same dispatch flow.

## 1. Pairing rules

1. Edge direction is always `from → to`, taken from the task's `from_node_id` /
   `to_node_id`. Never match on display name.
2. `from_node_id` empty, **or** `from_name == "scheduler"` (scheduled/system
   dispatch) ⇒ `from_node_id = null`, drawn as an edge from the **network
   core**. Legend text is fixed: “core → X = scheduled/system dispatch”.
3. The window is taken from `created_at` (dispatch time), not `delivered_at` or
   `completed_at`. Otherwise dispatched-but-unfinished work disappears from the
   picture.
4. `count` is an event count: one per task. Round trips inside the same
   `in_reply_to` thread count separately and are never merged into one.
5. Tasks with empty `to_node_id` are dropped (no target to anchor the edge).
   Their number goes to a data-quality log, not to the graph.
6. Self edges (`from_node_id == to_node_id`) are dropped.
7. Visibility depends only on the window: an edge is drawn iff `count > 0`
   inside it. No stale edges trail outside the window, no history ghosting.
8. One edge per ordered pair; `count` accumulates. No parallel edges for the
   same pair.
9. Every aggregate response carries completeness metadata (`coveredFrom`,
   `truncated`). A lower bound must render as “≥N”; it is never shown as an
   exact number.
10. Both ends must agree edge-by-edge on the same snapshot. Acceptance diffs
    them with zero tolerance (section 4).

## 2. Department → hue (shared by both ends)

The hue is derived from the department's **index after sorting**, spread evenly
over the 190°–275° band:

```ts
hue(i, N) = N > 1 ? 190 + (i / (N - 1)) * 85 : 190; // 190 cyan-blue → 275 blue-violet
color     = `hsl(${hue} 88% 64%)`;                 // disc / sector stroke
colorHigh = `hsl(${hue} 88% 72%)`;                 // highlighted state
```

| Item | Rule |
| --- | --- |
| Where `i` comes from | Departments sorted by `sort` ascending, missing values then by `id` lexicographic. Never by display name, never a hash — a rename must not repaint the org. |
| `N = 1` | Fixed at 190°. |
| Department add/remove | Re-sorting may legitimately repaint existing departments; a refresh, filter change, or network switch must **not** change any hue. |
| Scene palette | `deep` (cold space, default) / `warm` (amber ritual) is a whole-scene choice, not a department color. The App 2D view needs only the department hues. |
| Exceptions | Presentation mode and the light theme keep their own tuned palettes; this table does not apply there. |

Rounded hues for common department counts:

| N | i=0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 190 | 218 | 247 | 275 | | | | |
| 6 | 190 | 207 | 224 | 241 | 258 | 275 | | |
| 8 | 190 | 202 | 214 | 226 | 239 | 251 | 263 | 275 |

Current source of truth for the formula: `agent-network-dashboard` →
`app/legion/3d/page.tsx` (department disc stroke). This document only writes the
formula down as a two-end contract; it does not change any code.

## 3. Proposed Hub aggregate endpoint (not implemented)

```
GET /api/hub/task-edges?window=600&network_id=<id>

200 {
  edges: [ { from_node_id: string | null, to_node_id: string, count: number } ],
  coveredFrom: "2026-11-19T12:04:14Z",  // start of the covered window
  truncated: false                       // true ⇒ scan was cut, count is a lower bound
}
```

- `window`: seconds, default 600, valid range 1–86400. Invalid or out-of-range
  ⇒ `400`, never silently clamped.
- **Not bounded by the 200-row cap of `/api/hub/tasks`**: aggregate in SQL
  (`GROUP BY from_node_id, to_node_id`) and return only edges, so the raw task
  list never has to travel to the client.
- `from_node_id: null` means “core / scheduled dispatch” per rule 2. Clients
  must not treat it as a missing value and filter it out again.
- `truncated: true` ⇒ the client must render “≥N”.
- Permissions reuse the network-visibility check of `/api/hub/tasks`; no edge
  may cross a network boundary.
- Empty window ⇒ `edges: []`, `coveredFrom` still set to the window start,
  `truncated: false`.
- Optional extension (non-blocking): a `last_at` per edge so clients can fade
  the trail; omitting it must not change what is drawn.

## 4. Acceptance (each side runs these; thresholds stay as written)

| # | Check | Method |
| --- | --- | --- |
| 1 | Both ends agree on edges and counts | Fetch one snapshot per side for the same `network_id` + `window`, diff pair by pair, expect 0 differences. |
| 2 | `scheduler` and empty sender both map to `null` | Seed 3 tasks (scheduler / empty / normal); assert 2 edges, one with `from_node_id: null`. |
| 3 | Window uses `created_at` | Seed a task with `created_at` inside and `completed_at` outside the window; assert the edge still appears. |
| 4 | Thread round trips are not merged | 2 tasks sharing one `in_reply_to`; assert `count = 2`. |
| 5 | The 200-row cap does not apply | More than 200 events in the window; assert `truncated` matches reality and the response is not cut at 200. |
| 6 | Department hues are stable | Re-sort departments: hue changes only through the index change; refresh/filter leaves every hue untouched. |
