# 0.9.0-preview.180

> `/health` 现在报 Hub 自己所在磁盘的水位（`#2756`）。起因是一次**偶然**巡检。

## 为什么

2026-10-28 04:05 我做例行巡检时才发现根分区已经到了 **95%**（剩 28G）——
而上一轮清理（85%）之后它只用了一天多就涨回去 10 个点。

Hub 的数据库、日志、运行时目录都写在这块盘上，**写满即生产停摆**。
靠「偶尔看一眼」必然会漏，所以这个数字应该和 `sessions_count` / `event_loop` 一样随手可见。

## 改动

```json
"host_disk": { "path": "/home", "total_gb": 492, "used_gb": 429.5, "avail_gb": 43.2, "used_pct": 91 }
```

两个刻意的选择：

1. **探针打在数据库实际所在目录**（`COMMHUB_DB` 的目录），不是写死 `/` —— 把 DB 放独立卷的主机也能对上；
2. **只提供可观测，不做通知** —— 阈值与通知渠道属于运维策略；巡检脚本/客户端按 `used_pct > 90` 自己决定要不要叫。

`statfs` 失败时该字段为 `null`，不影响 `/health` 其它字段。

## 测试

`server/src/health-host-disk-2756.test.ts`（3 pass / 0 fail）：

```
形状完整：path / total_gb / used_gb / avail_gb / used_pct
数值自洽：used + avail ≈ total，used_pct ∈ [0,100]
探针目录 == COMMHUB_DB 的目录（不是 /）
与独立 statfs 复算对比：偏差 < 10 个点（防止把字节单位算错）
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.180
commhub-server --version   # 0.9.0-preview.180
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.180
commhub-server --version   # 0.9.0-preview.180
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.180` 后 `npm install`，
指到新目录再重启；`runtime-v179-preview179` 保留即可回滚，无数据迁移。

## 验收

```bash
curl -sS http://127.0.0.1:9200/health | python3 -c "import sys,json;print(json.load(sys.stdin)['host_disk'])"
# 期望：path/total_gb/used_gb/avail_gb/used_pct 都在，且 used_pct 与 df 一致
```

回滚：`HUB_RUNTIME_DIR` 指回上一版目录并重启；无 schema 变更。
