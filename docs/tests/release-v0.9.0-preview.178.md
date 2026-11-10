# 0.9.0-preview.178

> 排程退避的判据修正：**按窗口计数，不按连续链**（`#2622` 第二轮）。

## 为什么还要再修一次

`#3112` 上线（`.172`）后按生效点切窗口实测：

```
target_offline        1736/天 → 689/天   ✅ 有效
previous_run_active   2397/天 → 2258/天  ❌ 几乎没动
```

原因不是“失败不退避”，而是**现实模式是交替的**：

```
通信客户端欧 skipped 70 · TMA云盘欧 64 · 通信欧 63（4.3 小时内）
模式：跳过 → 跳过 → 成功 → 跳过…
⇒ 成功把“连续链”打断 ⇒ streak 永远攒不到阈值
```

本质：**工作周期（5–11 分钟）比排程间隔（180–420 秒）长**。

## 改动（8 行）

```
- 连续链：for (r of runs) { if (跳过且同因) streak++ else break }
+ 窗口：  runs.slice(0, 10).filter(跳过且同因).length
```

仍然要求**最新一次是同因跳过**（成功一次立刻恢复，不误伤正常排程）。

预期：交替型排程 0 → 600s（3–5 次）→ 1800s（≥6 次）；180s 基底约 480/天 → ~48/天。

## 测试

```
scheduled-noprogress-backoff-2622.test.ts  8 条
新增：skip, skip, replied, skip ⇒ 窗口计数=3 ⇒ 必须退避（旧逻辑算出 1，不退避）
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.178
commhub-server --version   # 0.9.0-preview.178
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.178
commhub-server --version   # 0.9.0-preview.178
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.178` 后 `npm install`，
指到新目录再重启；`runtime-v177-preview177` 保留即可回滚，无数据迁移。

## 验收

```bash
# 24h 后：previous_run_active 的日增量应从 ~2258 降到 ~50 量级
bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.env.HOME+"/.commhub/commhub.db");
for (const r of d.query("SELECT error_code, COUNT(*) c FROM scheduled_task_runs WHERE created_at >= datetime(\"now\",\"-1 day\") GROUP BY 1").all()) console.log(r);'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v177-preview177` 并重启；无 schema 变更。
