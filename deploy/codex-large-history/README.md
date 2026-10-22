# Codex 大历史节点恢复

适用于已保存的 Codex 会话可以恢复，但 `codex resume --remote` 的 TUI 因一次
`thread/read(includeTurns=true)` 返回过大的历史而退出的节点。通信牛在
2026-10-13 的原始 rollout 约 818 MiB，读取结果约 180 MiB。

`start-node.sh` 是本路径的权威启动入口；不修改全局 npm 包。它通过 anet 的
`--codex-bin` 参数使用 `codex-shim.sh`。app-server 仍使用原 Codex 可执行文件，
通信桥仍直接连接原 app-server。只有 TUI 通过 `preview-proxy.cjs` 连接同一个服务。
超出 48 MiB 的 TUI 历史响应会把大型历史 MCP 工具结果改为 2 KiB 文本预览。
轮次、用户消息、助手消息、工具调用参数与标识保留；原始磁盘历史与模型上下文
不修改。预览明确说明完整输出仍在原会话文件中。实时通知、其他客户端、其他
会话和发往模型的请求不改写。WebSocket 消息拆成 1 MiB 帧以兼容客户端限制。

## 启动、依赖和端口

需要 Bash、Node、tmux、已有 anet/Codex 安装，以及依据
`agent-network/package-lock.json` 安装的 `agent-network/node_modules/ws`。
安装依赖时在仓库执行 `npm ci --ignore-scripts --prefix agent-network`；不得覆盖
生产机的全局 npm 包。现有安装版本和来源仍由节点/主机部署记录管理，本脚本
不升级它们。代理源码、启动器和兼容等待时间的 preload 都在本目录。

停止目标节点后，从仓库执行：

```bash
cd /path/to/project
anet node stop <node-name>
ANET_CODEX_TUI_PROXY_PORT=24701 \
  /path/to/agent-orchestra/deploy/codex-large-history/start-node.sh \
  /path/to/project <node-name>
```

通信牛的项目目录是 `/home/vansin/comm-niu`，节点名是 `通信牛`。
其 app-server 在 `ws://127.0.0.1:24700`；代理只监听 `127.0.0.1:24701`。
多节点必须为各代理指定不同的空闲端口。此本机连接不使用反代或隧道。
代理与 TUI 在同一 tmux 会话，继承节点所有权标记；TUI 结束时代理退出，
`anet node stop` 按现有节点生命周期回收进程。不要启动另一份 app-server
同时写同一个 CODEX_HOME。

`startup-timeout.cjs` 是对当前已部署 anet 固定 15 秒恢复等待时间的兼容层，
仅本次启动进程把该等待时间延长至 120 秒，仍执行原来的恢复校验。preload
加载后清除相关环境变量，常驻子进程不依赖 preload 或临时文件。

## 配置、密钥和状态恢复

`ANET_CODEX_ACTUAL_BIN` 可指定现有 Codex 可执行文件，默认来自 `command -v codex`；
`ANET_CODEX_TUI_PROXY_PORT` 指定代理端口，默认 24701。这两个变量不含密钥。
启动器把它们写入节点私有的 `large-history-start.json`（mode 600），shim 从中
恢复设置，避免依赖已有 tmux server 是否继承新客户端的环境变量。该文件可
根据启动参数重新生成，不是唯一事实来源。
节点仍从其私有 `.anet/nodes/<name>/config.json`、`.env` 和隔离 CODEX_HOME
获取原有身份与登录凭据；密钥按现有安全渠道获取，不写入 Git。代理不读取或
记录这些凭据。代理日志位于 `CODEX_HOME/log/anet-tui-preview-proxy.log`，仅记录
响应大小与预览数量，不记录消息正文。

Git 只恢复脚本和依赖输入，不能恢复生产会话、节点令牌、Telegram 配对状态
或 Codex 登录数据。原会话和数据库依赖节点已有的私有恢复点及加密数据备份。
私有 `recovery/` 快照明确排除身份凭据；凭据需从现有安全密钥来源恢复或重新
登录/注册。本文不补充或假设未登记的远端备份位置和保留策略，也不宣称完成
空机灾难恢复演练。

## 验证、换版本和回滚

更新本目录代码后先运行独立 Docker 套件
`tests/test1260-codex-tui-large-history/`，结果保存于
`docs/tests/report-test1260.txt`。再按上面的启动命令重启目标节点；不能只以
Hub 的 idle 标签判定 TUI 健康。检查三份 tmux 会话的实际进程、TUI 已从
“Resuming session”进入可输入界面、原 thread ID、Hub/SSE 连接和最新健康日志。
本套件验证协议和大小限制，不替代真实 TUI 验证或模型推理测试。

若原聊天出现 `Chat stopped as a precaution`，这是独立的安全停止状态，
本代理不得绕过。历史成功加载也不表示该聊天可以继续。只有用户明确授权
切换后，才保留旧历史、暂停原自动任务、创建另一空白聊天并更新节点绑定。
不得把此前被停止的自动任务重新发送到新聊天。新的会话可执行一次独立的
无操作连接检查；暂停的调度应保持暂停，等待用户另行安排新任务。

回滚时停止目标节点，使用原来的 `anet node start <name> --copresence`。
原始历史没有改写，因此无需恢复会话文件。大历史的原有超时/消息大小问题
会再次暴露，回滚不表示该问题已解决。若修改其他节点配置，先保存私有配置
备份再操作；不要从 Git 获取生产密钥或数据。

Telegram 移除沿用现有 SOP：停止节点，从其 `config.json` 的 `channels` 移除
`telegram`，把 `channels/telegram` 移出自动发现路径或删除，然后重启并验证
启动日志中没有 Telegram polling。私有备份不得入库。
