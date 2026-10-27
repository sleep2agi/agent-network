# Hub 主机磁盘：什么时候查、能删什么、怎么验证

> 起因：2026-10-28 04:05 我**偶尔巡检**才发现根分区 95%（剩 28G）；而 10-27 那次清理后它只用一天多就从 85% 涨回 95%。
> 结论：磁盘不是「清理一次就完了」的事，是**会持续增长**的，必须有既定判据。

## 1. 先看这一格（不用登机也能看）

```bash
curl -sS http://127.0.0.1:9200/health | python3 -c "import sys,json;print(json.load(sys.stdin)['host_disk'])"
# {'path': '/home/vansin/.commhub/', 'total_gb': 491.8, 'used_gb': 449.2, 'avail_gb': 42.5, 'used_pct': 91.4}
```

`host_disk.used_pct` 与 `df` 同口径；探针打在 **数据库实际所在目录**，不是写死 `/`。
`> 90` 就该处理，`> 95` 属于「今天可能要出事」。

## 2. 能安全删的（我实测过引用关系）

| 路径 | 典型大小 | 判据 |
|---|---|---|
| `~/.anet-bin/anet-<旧版本>` | 每个 ~1G，几十个 | `ls -l ~/.local/bin/anet` 看符号链接指向哪个版本；**保留它 + 最新 2 个**，其余删 |
| `~/.bun/install/cache` | 可到 13G | bun 包缓存，纯可重下载；删后下一次 `bun install` 会重新下载（慢一次，不影响正确性） |
| `~/.commhub/runtime-v<旧版本>` | 每个 ~47M | `HUB_RUNTIME_DIR` 指向的那个必须留；再留上一个可回滚的，其余可删 |
| `~/.commhub/backups` | 可变 | DB 备份：保最新 2 份即可 |

**删前必做**（少一步就可能删掉在用的东西）：

```bash
# a) 有没有进程的工作目录在这些目录里
ls -l /proc/*/cwd 2>/dev/null | grep -c anet-bin          # 期望 0
# b) 节点配置有没有引用
grep -rho "anet-bin/anet-[0-9]*" ~/.anet/nodes/*/config.json 2>/dev/null | sort -u
# c) 当前 anet 指向哪个版本（这个不能删）
readlink -f ~/.local/bin/anet
```

## 3. 不能删的

- `~/.codex` / `~/.claude`：会话与登录数据，属于使用者本人；
- `~/.commhub/commhub.db` 及其 `-wal` / `-shm`；
- 正在被 `HUB_RUNTIME_DIR` 指向的 runtime 目录。

## 4. 实战记录（2026-10-28）

```
巡检发现 95%（28G free）
删 ~/.anet-bin/anet-91…117（14 个旧版本）    → 8.9G
删 ~/.bun/install/cache（5194 条目）         → 13G
结果：91%（43G free）
```

## 5. 为什么写这份而不是「记得清一下」

- 上次清理完是 85%，一天多就回到 95% —— **增长速度远快于「偶尔想起来」的频率**；
- 每次都要重新判断「哪个能删」，判断错一次就是生产事故；
- 现在 `host_disk` 在 `/health` 里，**判据固定**，动作固定，只剩执行。
