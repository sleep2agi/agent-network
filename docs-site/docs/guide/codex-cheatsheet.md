# Codex 节点速查：我想……就敲……

不想记命令？在节点所在的目录里敲：

```bash
anet node codex
```

它会列出这个目录里的 codex 节点（共存节点和 codex-sdk 节点都算），每个节点一行：
名字、在跑还是停了、有没有登录、当前会话（thread）的前 8 位、用的模型。
选一个节点，再选要做的事；**执行前会把等价的命令原样打出来，问你 y/N**，删除要把节点名完整敲一遍。
菜单本身不做任何事，它跑的就是它打印出来的那条命令——下表里的命令。

不在终端里（管道、脚本、AI 调用）时，`anet node codex` 只打印同一张表和下面这份速查，退出码 0。

下表里的 `my-node` 换成你的节点名，命令都在**节点所在的目录**里敲。

| 我想…… | 共存节点（codex TUI）就敲…… | codex-sdk 节点就敲…… |
|---|---|---|
| 启动 | `anet node codex start my-node` | `anet node start my-node --tmux` |
| 停止 | `anet node stop my-node` | `anet node stop my-node` |
| 重启 | `anet node codex restart my-node` | `anet node restart my-node --tmux` |
| 看看它好不好（自检） | `anet node codex verify my-node` | `anet info my-node` |
| 登录 codex | `CODEX_HOME=<节点目录>/codex-home codex login --device-auth` | `codex login --device-auth`（用本机 `~/.codex` 的登录） |
| 接着聊上一次 | 在跑：`anet attach my-node`；停了：`anet node codex start my-node`（自动接回记录的会话） | 在跑：`anet attach my-node`；停了：`anet node start my-node --tmux` |
| 换模型 | `anet node edit my-node --model <模型>`，再重启 | 同左 |
| 复制一个节点 | `anet node codex fork my-node --name my-copy --workdir ../my-copy --no-codex-login` | `anet node clone my-node my-copy` |
| 删除 | `anet node delete my-node --force` | 同左 |
| 看每个节点有没有登录 | `anet node codex login-status` | 同左 |

几点说明：

- **登录**：`<节点目录>` 是 `.anet/nodes/my-node` 的绝对路径；菜单里选「登录」会把完整路径替你填好。
  一个 codex 登录只给一个节点用（见 [一个登录只给一个节点](/guide/codex-copresence#one-login-per-node)），
  所以复制出来的节点要自己登录一次，`--no-codex-login` 就是这个意思。
- **接着聊**：`anet attach` 进入节点的 tmux 会话；`Ctrl-B` 再按 `D` 退出来，节点继续跑。
- **换模型**只改配置，重启后才生效。
- **删除**会先把节点停掉，再删 `.anet/nodes/<节点>/` 和 Hub 上这个节点的那一行，不能撤销。
  不加 `--force` 只预览要删什么。
- 每条命令的完整参数：`anet node codex --help`、[CLI 参考](/guide/cli)、[Codex TUI 人机共存](/guide/codex-copresence)、[复制节点](/guide/copy-node)。
