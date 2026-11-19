# Nodes report their lists up front (skills first)

Status: draft for review. Prompted by admin on 2026-11-19, who said 「这些现在感觉都好慢啊」 and 「要引入中间件吗」.

## Problem

The skills, files and logs panels all fetch **on demand**:

```
App ──POST──▶ Hub: insert into node_rules_requests (pending)
                   + doorbell ─▶ node (if it is listening)
              node claims, enumerates the directory, writes the result back
App ◀─polls every 0.7–3s── Hub: wait for a terminal status
```

- **Speed:** opening a panel costs one Hub-to-node round trip, a directory walk on the node, and several App polls. That adds up to several seconds.
- **Node not claiming:** if the node is alive but never claims the request, the App waits for `RULES_REQUEST_STALE_MS = 60s`. This happens when the doorbell is lost, the runtime claims `skills_capable` but doesn't actually listen, or the node is busy. The App then shows 「节点 60 秒内没有取走这次请求」, which is what admin saw.
- **No caching:** nothing is stored at any layer. Every open starts over. The App-side cache was added in app#1553, but the first open is still slow.

A message queue (Redis Streams, NATS, Kafka) **does not fix this**. The request still has to reach the node and wait for its answer. The slow part is asking the node at the moment of use, not the transport between the Hub and the node.

## Proposal: nodes push snapshots, the Hub serves them

```
node ──report_status(skills_snapshot)──▶ Hub: upsert node_snapshots
App ──GET /api/nodes/:id/snapshot?kind=skills──▶ Hub ──▶ returns immediately (tens of ms)
```

### Node side (agent-node / agent-network)
- **When to push:** on register / resume, and whenever the hash of `listSkills(runtime, ctx)` changes. The hash is checked every 60s, and right after a skill sync or install. The node does a cheap `stat` scan and only recomputes the list when an mtime changes.
- **What to push:** `{ kind: 'skills', hash, generated_at, roots: [display names only], skills: [{ name, scope, origin, description }] }`. The body stays capped at 64KB, and `SKILL.md` contents are **not** included. `skill_read` stays on demand, because it is a single file and fairly fast.
- **When not to push:** if the hash is unchanged, nothing is sent. The heartbeat carries `skills_hash` only.

### Hub side (server)
- **New table:** `node_snapshots(node_id, network_id, kind, hash, payload, updated_at)`, with primary key `(node_id, kind)`.
- **Ingest:** `report_status` takes optional `skills_snapshot`. Validation matches today's `skills_list` result: path redaction, name regex, and the 64KB size cap.
- **New read endpoint:** `GET /api/nodes/:node_id/snapshot?kind=skills`. Permissions match today's skills view (same network, `skills_capable`). The response includes `updated_at` and the node's online state.
- **Compatibility:** old nodes push no snapshot, and the endpoint returns 404 with `reason: 'no_snapshot'`. The App then falls back to today's on-demand path.

### App side
- **Open order:** the App cache shows first (app#1553). Next comes the Hub snapshot, with an 「x 分钟前」 label when `updated_at` is old. The old on-demand flow is used only when neither exists.
- **Refresh button:** triggers an on-demand refresh. The node writes the new result back as the snapshot too.
- **No snapshot and the node didn't claim:** if the session has no snapshot and the node hasn't claimed the request after 8s (not 60s), say so right away: 「这个节点暂时没响应技能查询，节点上线后会自动上报」.

## Rollout
1. Hub: table, ingest and endpoint, with tests. Released as a Hub patch. Blocked on the npm credential.
2. Node: push and hash check, behind `ANET_SNAPSHOT_PUSH=1` for one day on vdev, then on by default.
3. App: read the snapshot before the on-demand path, plus the 8s fail-fast.
4. Once skills is stable, apply the same pattern to the **files top level** (one level, at most 200 entries). Logs stay on demand because they change every second.

## Performance targets (checked in CI)
- Opening the skills panel with a snapshot available: < 100ms to the first list.
- Hub `GET snapshot` p95: < 30ms.

## Not in scope
- No new middleware. Revisit NATS only if the Hub has to scale out across machines or nodes reach the 5k+ range.
