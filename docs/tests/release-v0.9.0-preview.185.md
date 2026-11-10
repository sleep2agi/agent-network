# 0.9.0-preview.185

> 一个常量的修正：让「拦截率」的分母能活满整个保留期，而不是在第 11 天**静默停表**。

## 问题

`.184` 引入的 `node_tool_calls` 沿用了拒绝日志的 20 000 行上限。但两张表的行增长方式完全不同：

```
node_permission_log  只写「本来会被拒」——生产 30 天 0 行
node_tool_calls      每次调用都写；键里带 hour，每过一个小时就是一批新键
```

生产实测（`.184` 上线首小时）：

```
T01  66 行（启动波：各节点各建一次 SSE）
T02  25 行（该小时过了 20 分钟 ⇒ 约 75 行/小时）

75 × 24 = 1 800 行/天
20 000 ÷ 1 800 ≈ 11 天   <   保留期 30 天
```

撞上限的后果不是变慢，是 `callLogFull` 分支只给已有行加次数、**不再插新行** ——
而键含 `hour`，新的一小时全是新键 ⇒ **一行都写不进去，计数静默归零**（不报错、不告警、不比平时慢）。

而这张表正是 #525「要不要切 enforce」的判据：读到归零会把「没人调用」当成结论。

## 改动

```
TOOL_CALL_MAX_ROWS  20 000 -> 200 000
```

实测 91 行 = 12 KB ⇒ 200 000 行 ≈ 26 MB，对这张表完全可接受；按 75 行/小时可覆盖 30 天保留期并留 2 倍余量。

没有改成「天桶」：小时粒度对排查仍有价值，抬高上限是更小的改动，也不损失分辨率。

## 测试

新增一条**不变量**测试（不是行为测试）：

```
TOOL_CALL_MAX_ROWS >= LOG_RETENTION_DAYS × 24 × 100 行/小时
```

即「上限必须覆盖整个保留期（按 100 行/小时的余量）」。将来任何人调小上限、或把保留期从 30 天改长，都会当场红。

变异对照：把上限改回 20 000 → 该用例立刻失败（20 000 < 72 000）。
套件：`node-permissions-http` 20 pass（原 19 + 新增 1）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.185
commhub-server --version   # 0.9.0-preview.185
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.185
commhub-server --version   # 0.9.0-preview.185
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.185` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；无 schema 变更、无数据迁移。

## 验收

```bash
# 计数表应持续增长（不再在某个时刻停住）
curl -sS http://127.0.0.1:9200/api/networks/<net>/node-permission-report \
  -H "Authorization: Bearer <user-token>" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("tool_calls", d["tool_calls"]["total"])'
# 期望：与上一次读数相比有增长（除非这一小时真的一次受限调用都没有）
```

回滚：`HUB_RUNTIME_DIR` 指回 `.184` 目录并重启；只改了一个常量与一条测试，无数据迁移。
