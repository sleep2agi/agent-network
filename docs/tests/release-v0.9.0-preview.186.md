# 0.9.0-preview.186

> 节点「假活」不再静默：连续确定性失败时，给节点主人发一条可行动的通知。

## 问题（生产实测）

TMA客户端鲸 因缺 `DEEPSEEK_KEY`，**9 天失败 1433 次，零告警**。

节点在线、进程在、版本正常、`get_session_status` 返回 `idle` —— 但每个任务都失败。
失败只写在任务回执的 `result` 文本里，巡检只看状态就会判「没回复 = 没在做」。

## 设计（阈值与类别都用近 7 天生产数据校准）

```
只对确定性错误告警：缺环境变量 / 二进制缺失 / 登录失效
  含 timeout 的版本：7 天 35 条（其中 29 条是 timeout）→ 会变成新噪音源，弃用
  只算确定性错误：  7 天 6 条 = 0.9/天

阈值 5 次连续（同节点 + 同类别）
同一次故障只告一次：按 (节点, 类别, 首现时刻) 去重；中间出现成功即重新武装
走已有 user_inbox 通道（与 schedule_stuck 同一套），不新造通知面
```

校准的关键数字：**1433 次失败会被压成 5 条告警**（287:1）。

## 改动

```
server/src/node-failure-alert.ts   分类 + 连续计数 + 去重 + 发通知（纯读，不改任何状态）
server/src/server.ts               5 分钟一次的定时器 + shutdown 清理
```

定时器周期可用 `COMMHUB_NODE_FAILURE_ALERT_MS` 覆盖；设成很大的值即可整体关闭。

## 测试

```
4 条全绿：
  分类：3 类确定性错误认得；timeout 与任务内容错误返回 null
  连续 5 次缺环境变量 → 恰好 1 条；再扫不重复发
  连续 10 次 timeout → 不告警（校准结论的回归钉）
  中间夹一条成功 → 断开，不告警
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.186
commhub-server --version   # 0.9.0-preview.186
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.186
commhub-server --version   # 0.9.0-preview.186
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.186` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；只新增一个定时器与一个模块，无 schema 变更、无数据迁移。

## 验收

```bash
# 部署后 5 分钟内应看到扫描日志（只有真的发过告警才会打印）
grep -a "node-failure-alert" ~/.commhub/pm2-hub-err.log | tail -3

# 若想立刻验证一次（造一条假失败不会触发：阈值是 5 次连续）
# 正常情况下一周 5-7 条，对应「某节点真的缺配置/凭据」这类必须人处理的事
```

回滚：`HUB_RUNTIME_DIR` 指回 `.185` 目录并重启；或把 `COMMHUB_NODE_FAILURE_ALERT_MS` 设成很大的值关掉告警。
