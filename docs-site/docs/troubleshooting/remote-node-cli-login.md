# 远程 daemon 建节点：Claude Code CLI 登录态不能跨机复用

> 从 dashboard 选一台远程 host（host_supervisor daemon）建节点时，有的能跑、有的起不来。多半不是 bug，而是 **agent 的 auth 方式决定了它能不能跨机**。

## 两种 auth，命运不同

anet 节点跑起来需要 vendor 认证。认证有两条路，跨机行为完全不同：

| auth 方式 | 存在哪 | 跨机复用 |
|-----------|--------|----------|
| **API key**（DeepSeek / MiniMax / Anthropic API key 等） | 节点 config + hub secret vault | ✅ 跟着节点走，远程 host 直接能用 |
| **Claude Code CLI 订阅登录**（`claude auth login` 的 OAuth） | 该机器的 `~/.claude` | ❌ 机器绑定，不进 config，不传远程 |

- 用 **API key** 的节点 → 在任意 daemon 上建都能跑（key 跟着 config / vault 走）。这正是 dashboard「供应商预配置库」要解决的。
- 用 **claude-code-cli 订阅登录** 的节点 → 只有**那台机器已经 `claude auth login` 过**才能跑。远程 daemon 没登录态 → 节点起不来。

## 症状

- 本机建节点正常；选远程 daemon 建同款节点，节点起不来 / 无响应。
- 节点用的是 `claude-code-cli` runtime + 订阅登录（不是 API key）。

## 怎么办

1. **多机 / 远程场景，优先走 API key 路线**：在 dashboard 供应商库里配好 vendor + model + key（key 写入即进 vault，跟着节点走），建节点时选这个 preset。跨机零门槛。
2. **一定要用 claude-code-cli 订阅登录**：先 SSH 到那台远程 host，在该 host 上 `claude auth login` 一次，登录态落到该机 `~/.claude`，之后该 host 上的 claude-code-cli 节点才能跑。
3. 登录态是敏感凭据、Claude CLI 本就设计成机器绑定，anet **不会**替你把 `~/.claude` 传到远程 host（安全考量）。

## 为什么不是 bug

Claude Code CLI 的订阅登录态机器绑定、不可移植，是 Claude CLI 的设计（凭据安全）。anet 能做的是把 **API key 类**认证做成跟着节点走（provider 库 + vault），claude-code-cli 订阅登录留给已登录的机器。
