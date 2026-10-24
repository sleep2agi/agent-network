# Runbook：给一个节点开启「团队规则」（`ANET_TEAM_RULES`）

> 适用版本：`agent-node >= 2.5.0-preview.156`、`agent-network >= 2.3.0-preview.193`、Hub `commhub-server >= 0.9.0-preview.153`。
> 背景与语义：[RFC-043](../rfcs/RFC-043-team-rules-inheritance.md)。本 runbook 只讲**怎么开、怎么验、怎么退**。

## 0. 先确认这条链路是通的（不需要动节点）

```bash
# 1) Hub 上这份网络的规则（空内容也正常，返回 revision 0）
TOKEN=$(jq -r .token <节点目录>/config.json)
NET=$(jq -r .network_id <节点目录>/config.json)
curl -s "http://127.0.0.1:9200/api/networks/$NET/rules" -H "Authorization: Bearer $TOKEN"

# 2) 发布产物真的有这个行为（四种情形全断言）
bash scripts/verify-team-rules-artifact.sh 2.5.0-preview.156
```

第 2 步全 PASS 才继续；它证明的是 npm 上那串字节会做这件事。

## 1. 选节点、备份、看清它用哪个文件

```bash
NODE=<节点目录>
ls "$NODE/CLAUDE.md" "$NODE/AGENTS.md" 2>/dev/null   # claude 节点看 CLAUDE.md，其余看 AGENTS.md
cp "$NODE/AGENTS.md" "/tmp/AGENTS.bak-$(date +%Y%m%d-%H%M%S)"   # 文件名按上一步实际存在的那个
```

> 受管块会加在文件**最前面**。备份是为了两条：对比，以及回滚。

## 2. 带上环境变量并**完整重启**该节点

```bash
# 用你自己的启动方式，关键是这次进程的环境里要有这个变量
ANET_TEAM_RULES=1 anet node start <alias>
```

要求是**完整重启**（stop → start），不是只重启 bridge：注入只在启动时发生一次。

## 3. 看日志、看文件

日志里应出现一行（后面跟着正常的启动日志）：

```
[team-rules] injected revision=<R>          ← 首次注入 或 版本变了
[team-rules] unchanged revision=<R>         ← 版本没变，文件不会动
[team-rules] skipped (no_rules)             ← Hub 上这份规则是空的
[team-rules] skipped (hub_unreachable)      ← Hub 不通，文件原样
[team-rules] error (<原因>)                  ← 标记残缺等，文件原样
```

然后核对文件：

```bash
diff -u "/tmp/AGENTS.bak-…" "$NODE/AGENTS.md"
#   期望：diff 里**只有新增**的受管块；你自己的内容一行都不该被删改
head -8 "$NODE/AGENTS.md"
#   期望：<!-- ANET:TEAM-RULES v<R> BEGIN … --> 在第一行
```

再启动一次，应得到 `unchanged`，且文件**逐字节不变**：

```bash
md5sum "$NODE/AGENTS.md"; # 重启后再算一次，应相同
```

## 4. 改规则后会发生什么（重要）

Hub 上改一次规则 → revision 增加，但**该节点不会自动变**（v1 不做运行中推送）。
节点会一直用旧块，直到**下次完整启动**才注入新版本。这是设计（运行中改写会让正在跑的 turn 读到半新半旧的内容）。

## 5. 关掉它 / 回滚

```bash
# 去掉环境变量后完整重启即可；已写入的块不会被自动删除
ANET_TEAM_RULES=0 anet node start <alias>
```

要真的把块从文件里去掉（三种方式，选一）：

```bash
# a) 手工删掉 BEGIN 与 END 之间的整段（含两行标记）
# b) 还原备份
cp "/tmp/AGENTS.bak-…" "$NODE/AGENTS.md"
# c) 用既有的单节点规则文件写回（会把整个文件覆盖为你给的内容，小心）
```

> 为什么关掉后不自动删块：删块等于**静默撤回**团队规则，而人就不知道规则为什么消失了。

## 6. 常见误判

| 现象 | 不是故障 |
|---|---|
| 日志 `unchanged`，文件时间变了但内容一样 | 说明没写入（我们比对内容，不看 mtime） |
| Hub 上改了规则，节点没反应 | v1 只在完整启动时拉取 |
| 文件里只有 `BEGIN` 没有 `END` | 上一次写入被打断；节点会**拒绝写入并报原因**，按提示修好标记 |
| `skipped (no_network_scope)` | 这个令牌不是网络作用域的节点令牌（多半是全局登录态） |

## 7. 这一版的边界

- 只注入 **Hub 一层**；Daemon 级规则、层间冲突裁决、合并总长上限、安全键都还没有实现（RFC-043 §8）。
- 没有客户端页；规则文本目前只能通过 `PUT /api/networks/:id/rules` 写。
- 不做执行期强制：规则只是文本，模型读到它，但没有人会“因为违反规则而拦下任务”。
