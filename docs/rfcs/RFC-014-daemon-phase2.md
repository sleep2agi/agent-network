# RFC-014 — Hero A: #99 守护节点 Phase 2 (host metrics 闭环)

**作者**: 通信SDK马
**状态**: Draft v2 (通信牛 first pass APPROVE WITH SMALL AMENDS — v2 fold-in)
**版本**: v1 初稿 → v2 (通信牛 [comment 4468702969](https://github.com/sleep2agi/agent-network/issues/99#issuecomment-4468702969) 3 amends)
**关联 issue**: #99 (守护节点 Phase 2), #119 (host telemetry Step 1 — shipped v0.10.0), #142 (process_telemetry — shipped v0.10.0)
**关联 ship**: v0.11.0 candidate
**作者预 finding**: 90% 已 shipped, **scope 远小于初始 3-4d 估算** — 实际 ~1-1.5d

> **v2 变更说明** (通信牛 first pass): audit 成立, 3 amends:
> - **§2.1**: disk 采集改 `execFileSync("df", ["-k", "/"])` 避 shell pipe — Linux/macOS 都 KB×1024 (per repo shell-pipe audit hygiene)
> - **§2.2**: response field 改 `current` → `latest` (跟 server 现状对齐, 不动 server)
> - **#99 close gate**: 不 standalone, gate 在 Docker smoke disk 非 null + dashboard alert/history render LIVE verify

## 1. 背景 + 现状审计

### 1.1 #99 Phase 2 初始 framing (通信龙 5413 dispatch)

> "Per-server CPU/Mem/Load/Disk 5min/1h/24h 历史 ramp 真实采集 + alert_level 阈值 + dashboard 红/黄/绿 LIVE + 跨平台"

**初始假设**: 这是 greenfield daemon 工作, ~3-4d.

### 1.2 实测 audit (Hero A research, ~30min)

**commhub-server@0.8.2 (latest) 实际状态**:

| Phase 2 要求 | 现状 | Gap |
|---|---|---|
| Per-server CPU/Mem/Load 采集 | ✅ `report_status.host` 接收 (`tools.ts:143`), 完整字段: cpu_load_1min / cpu_cores / mem_total_gb / mem_used_gb / mem_avail_gb / hostname / ip | 0 |
| Per-server Disk 采集 | ⚠️ schema 有 disk_total_gb / disk_used_gb / disk_avail_gb 字段, server-side 接收 OK | **agent-node `host-telemetry.ts` 不采集** (grep 零命中) |
| **5min 历史 ramp** | ✅ `bucketTelemetry(rows, now - 5*60*1000, 60*1000)` (`index.ts:1128`) — 1min bucket | 0 |
| **1h 历史 ramp** | ✅ `bucketTelemetry(rows, now - 60*60*1000, 5*60*1000)` (`index.ts:1129`) — 5min bucket | 0 |
| **24h 历史 ramp** | ✅ `bucketTelemetry(rows, now - 24*60*60*1000, 60*60*1000)` (`index.ts:1130`) — 1h bucket | 0 |
| alert_level 阈值 | ✅ `serverAlertLevel()` (`index.ts:248-268`): red >= 80% / mem<0.5GB / disk<1GB · yellow >= 60% / mem<1GB / disk<5GB · green else | 0 |
| `/api/server/:host/health` endpoint | ✅ exposes alert_level + history bucketing | 0 |
| Dashboard 红/黄/绿 LIVE | ❓ N站马 lane (need verify dashboard render alert_level field) | 验证 |
| **跨平台 Linux/macOS/Windows** | ✅ Linux uses `/proc/loadavg` + `/proc/meminfo` · 其他用 `os.loadavg() / os.totalmem() / os.freemem()` fallback · Windows 0-loadavg coerced to null (per host-telemetry.ts:64-77) | **Windows disk 0** (因 agent-node 不采 disk) |

### 1.3 真 scope (audit 后)

**Hero A Phase 2 实际是 "complete the last 10%", 不是 greenfield daemon**:

1. **Agent-node host-telemetry.ts add disk** (~30 LOC, ~30min):
   - Linux: `statfs(2)` via `child_process.exec('df -B1 / | tail -1')` 或 `import fs.statvfsSync`
   - macOS: same `df` approach
   - Windows: `wmic logicaldisk` 或 mark disk_*_gb=null (graceful)
2. **N站马 dashboard render alert_level** (~1d if not done, verify first):
   - `/api/server/:host/health` 现已返回 alert_level + history. UI 显示 chip color + sparkline.
3. **Verify cross-platform** (~30min Docker smoke):
   - Linux/macOS Docker test pass, Windows skip (best-effort)
4. **Documentation + CHANGELOG** (~15min)

**Total**: ~2-3 hour SDK马 own + N站马 dispatch (verify or implement).

## 2. 设计

### 2.1 Agent-side disk telemetry (~30 LOC additive)

```typescript
// agent-node/src/host-telemetry.ts — add to readMemoryStats() peer
interface DiskStats { total: number | null; used: number | null; avail: number | null }

function readDiskStats(): DiskStats {
  if (osPlatform() === "linux" || osPlatform() === "darwin") {
    try {
      // v2 (通信牛 first pass amend): use execFileSync to avoid shell pipe
      // (per repo shell-audit). `df -k /` returns KB-based output unified
      // across Linux and macOS — both platforms KB×1024 → bytes. No more
      // -B1 (Linux-only) vs -k (macOS) divergence.
      const out = execFileSync("df", ["-k", "/"], { encoding: "utf-8", timeout: 1000 });
      // df output: header + one data row. Pick last non-header line.
      const lines = out.trim().split(/\n/);
      const fields = (lines[lines.length - 1] || "").split(/\s+/);
      const totalKb = parseInt(fields[1], 10);
      const usedKb  = parseInt(fields[2], 10);
      const availKb = parseInt(fields[3], 10);
      if (Number.isFinite(totalKb) && Number.isFinite(usedKb) && Number.isFinite(availKb)) {
        return { total: totalKb * 1024, used: usedKb * 1024, avail: availKb * 1024 };
      }
    } catch { /* fall through */ }
  }
  // Windows / fallback: leave null
  return { total: null, used: null, avail: null };
}

// in getHostTelemetry():
const disk = readDiskStats();
const value: HostTelemetry = {
  ...existing,
  disk_total_gb: toGb(disk.total),
  disk_used_gb: toGb(disk.used),
  disk_avail_gb: toGb(disk.avail),
};
```

**v2 notes**:
- `execFileSync("df", ["-k", "/"])` avoids the shell-pipe pattern flagged in repo's recent shell audit. No `tail -1` needed — we just take the last line of the output buffer.
- `-k` is POSIX-standard, supported on both Linux and macOS, both report KB. Unified parse logic, no platform branch within the success path.

### 2.2 Dashboard side (N站马 dispatch)

`/api/server/:host/health` response already 含:
- `alert_level: "green" | "yellow" | "red"`
- `alerts: string[]` (e.g. `["cpu 85%", "disk 0.8GB available"]`)
- `latest: { cpu_load_1min, cpu_cores, mem_avail_gb, mem_used_gb, disk_avail_gb, disk_used_gb }` *(v2: 通信牛 catch — actual server returns `latest` not `current`. Verify before N站马 dispatch.)*
- `history: { "5m": [...], "1h": [...], "24h": [...] }`

N站马 render:
1. Chip color = alert_level
2. Tooltip = alerts joined
3. Sparkline = history.5m / 1h / 24h (按 user toggle)

LOC = N站马 lane估算.

### 2.3 跨平台 matrix

| OS | CPU | Mem | Disk | 通过 |
|---|---|---|---|---|
| Linux | `/proc/loadavg` | `/proc/meminfo` | `df -B1` | ✅ |
| macOS | `os.loadavg()` | `os.totalmem()` + `os.freemem()` (approx) | `df -k` + `* 1024` | ✅ |
| Windows | `null` (loadavg 0-coerced) | `os.totalmem()` | `null` (graceful) | ⚠️ disk + cpu 缺数据但 graceful |

Windows degraded path acceptable for v0.11.0; can add `wmic logicaldisk get size,freespace` in v0.11.x follow-up if any Windows users surface.

## 3. Test

Single Docker case sufficient (~30min):
- node:24-alpine + agent-node@preview + commhub-server@preview
- agent register → server `/api/server/<host>/health` returns alert_level + history + disk fields populated
- Assert `disk_total_gb / disk_used_gb / disk_avail_gb` non-null on Linux

## 4. Ship 路径

**v0.11.0** preview chain:
1. agent-node 加 disk (~30min impl)
2. agent-node 加 disk test (~10min)
3. ship `agent-node@2.5.0-preview.X`
4. N站马 dashboard render (verify or implement) — parallel
5. Docker chain smoke
6. Promote latest

**Total ETA**: 2-3 hours SDK马 own. N站马 lane lead-time depends on dashboard current state.

## 5. Open questions

1. macOS df -k vs Linux df -B1: 是否 worth unified `df -k` to simplify? (yes — same parse logic)
2. Windows disk 是否值得 v0.11.0 内 implement (`wmic`)? 当前用户 0 Windows (agent-node), 推 v0.11.x follow-up.
3. alert_level 阈值 (80% / 60% / 0.5GB / 1GB / 5GB) 现 hardcoded — 是否要 config 化? 当前推 hardcode, 若用户 surface 再加 v0.11.x.

## 6. v0.11.0 Hero A status

✅ 已 shipped (v0.10.0): host telemetry collection + storage + aggregation + alert_level + history bucketing
⚠️ Gap (本 RFC 修): agent-node disk collection + cross-platform graceful
❓ Pending verify: N站马 dashboard 已 render alert_level + history? (need check)

## 7. #99 close gate (v2 amend per 通信牛)

#99 issue 不 standalone close on RFC ship. Gate 在:

1. ✅ agent-node disk fields 非 null Docker smoke PASS
2. ✅ Dashboard alert_level chip render LIVE verified (N站马 lane)
3. ✅ Dashboard history sparkline 5m/1h/24h render LIVE verified
4. ✅ Cross-platform: Linux PASS + macOS PASS (Windows graceful null acceptable)

仅 RFC ship + agent-node disk impl ≠ #99 close. 全 chain (server schema → agent push → dashboard render) verified 才 close.

**Status**: Draft v2 (通信牛 first pass APPROVE WITH SMALL AMENDS, v2 fold-in), awaiting 通信龙 ack on scope re-framing ("90% done not 3-4d daemon") + 通信牛 second pass + Vincent telegram ack.

**作者**: 通信SDK马 · 2026-05-17
