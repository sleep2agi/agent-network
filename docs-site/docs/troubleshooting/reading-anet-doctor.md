# `anet doctor` 的输出怎么读

`anet doctor` 是「我这台机器现在好不好」的第一道命令。它**只看本机 + 它连的那个 Hub**，
不去探任何节点是不是活的 —— 那一格见[这个节点还活着吗](/troubleshooting/is-this-node-alive)。

一次真实输出（截自一台已配置好的机器）：

```
anet doctor — System Diagnostic

  ✅ Global config (~/.anet/config.json) (http://127.0.0.1:9200)
  ✅ Auth token configured
  ⚠  Package file modes: umask is 0002, so npm extracts packages group-writable …
  ✅ CommHub reachable (http://127.0.0.1:9200 v0.9.0-preview.38；本机 anet hub start 钉 0.9.0-preview.44)
  ℹ  API version: v3
  ℹ  Sessions: 271 registered
  ℹ  SSE connections: 127 active
  ✅ No plain-secret config (all env values are either non-secret or envRef objects)
  ✅ Claude Code CLI (2.1.251 (Claude Code))
  ✅ Codex CLI (codex-cli 0.149.1)
  ✅ Bun runtime (1.4.0)
  ✅ SkillHub catalog (7 skill(s) available …)

  Result: 9 ok, 3 warnings, 1 errors
```

## 四种前缀各是什么意思

| 前缀 | 含义 | 计入结果行吗 |
| --- | --- | --- |
| ✅ | 这一格判过了，并且是好的 | 计入 `ok` |
| ⚠ | 判过了，不算坏但值得知道（例如 umask 会让 npm 解出组可写的包） | 计入 `warnings` |
| ❌ | 判过了，是坏的 | 计入 `errors` |
| ℹ | **只是把一个事实摆出来，不做判断** | **不计入任何一项** |

🔴 **`ℹ` 不是「没问题」，是「这道命令不替你判断这一格」。** 例如
`Sessions: 271 registered` 说的是名册里有 271 条会话记录 —— 它**不**表示
271 个节点都活着（名册里长期有大量 offline 行）。

## 版本那几行：只报，不判

```
✅ Claude Code CLI (2.1.251 (Claude Code))
✅ Codex CLI (codex-cli 0.149.1)
✅ Bun runtime (1.4.0)
```

🔴 **括号里是实际装着的版本，这几行不做「够不够新」的判断。**

原因是实测过一次：`codex-cli 0.149.1` **装着**，但解不动上游 models 响应里一个
它不认识的推理档位，rmcp worker 因此致命退出，用户看到的是 300s 超时 ——
而当时 doctor 只检查了「在不在」，给的是一个 ✅。

那么为什么不干脆加一个最低版本判据？因为「多少版本才够」**由上游返回什么决定**，
不是我们能钉死的常量；猜一个下限，会在别人升级 CLI、上游又改动之后变成误报，
而一个会误报的检查第一周就会被关掉。**把实际版本摆出来、让读的人自己对上号，
是这一格能诚实做到的全部。**

⇒ 排查一条「莫名其妙的超时」时，先看这几行的版本号，再决定要不要升级。

## Hub 那一行:两个版本号并排

```
✅ CommHub reachable (… v0.9.0-preview.38；本机 anet hub start 钉 0.9.0-preview.44)
```

前一个是 **Hub 自报的版本**,后一个是**这台 CLI 里 `anet hub start` 钉死的版本**。
🔴 **两者一致时后半句不显示** —— 只在不一致时才提醒你有个差。

同样地,这里**不判断谁对**:hub 比 pin 老或新都可能完全合理(你连的是别人运维的
hub、本机 hub 还没重启、或者故意钉在旧版)。摆出两个数,让读的人自己决定要不要动它。

⇒ 排查「某个功能在这台 hub 上行为不对」时,先看这两个数差多少。

## grok build 那一行：它说的是「**下次重启**会怎样」，不是现在坏了

只有 runtime 是 `grok-build-cli` / `grok-build-acp` 的节点才有这一格。

grok CLI 会**自我更新**。更新之后，**正在跑的节点完全不受影响** —— 它用的是启动时
那份进程；名册上也仍然是 `idle`。**只有重启才会用上 PATH 上的新版本**，而重启正是
升级 agent-node 之后必须做的动作（#1615）。

这一行比的是「该节点**启动时**用的 grok」与「**现在** PATH 上的 grok」：

| 你看到的 | 它的意思 |
| --- | --- |
| `ℹ … （与该节点启动时相同）` | 没有漂移 |
| `ℹ … （同一 build，仅频道标签不同）` | 只差 ` [stable]` 之类的频道标签，**同一个 build**，不是漂移 |
| `⚠ 启动时 X → 现在 PATH 上是 Y` | **漂移**。当前运行不受影响，但下次重启会用 Y；若 Y 不在验证清单里，节点会拒绝启动 |
| `⚠ 无法问出本机 PATH 上的 grok 版本` | `grok` 不在 PATH，或 `--version` 输出不是已知形状 —— **不等于没问题** |
| `⚠ 节点日志里没有启动横幅` | 日志轮转掉了，或它从未成功启动过 —— 同样**不等于没问题** |

撞到漂移时，旧二进制通常还在 `~/.grok/downloads/`：

```bash
GROK_BINARY=~/.grok/downloads/grok-<旧版本>-<平台> anet node start <node>
```

🔴 这一行**不判断版本合不合法**。验证清单住在 `agent-node` 里，而 `anet` 这个包
不依赖它 —— 与其抄一份会静默漂掉的副本，不如只报「变了没变」。
「变了」本身就足以让你在重启之前知道要小心。

## 它**回答不了**什么

这一节比上面几节都重要 —— 一条诊断命令最危险的用法是拿它回答它没在判的问题。

- **不回答「我的节点还活着吗」。** doctor 不给任何节点发探针。
  `Sessions: N registered` 是名册计数，不含活性成分。
  → [这个节点还活着吗](/troubleshooting/is-this-node-alive)
- **不回答「Hub 上的数据对不对」。** 它只打了 `/health`。
- **不回答「我的 runtime 能不能真的跑起来」。** 版本那几行只证明二进制在、能报版本。
- **`0 node(s)` 不是故障。** 全新安装本来就没有节点；但如果你本来有，
  那说明配置目录不见了 —— 这两种 doctor 分不出来，所以它两种都说，不替你挑一种。

## `--fix` 会改东西

`anet doctor --fix` 会执行兼容迁移、并重新签发被 Hub 拒绝的节点 token。
**它会修改配置**，不是只读。先跑不带 `--fix` 的看清楚再决定。
