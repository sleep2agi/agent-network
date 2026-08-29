# @sleep2agi/agent-node 2.5.0-preview.51 — release notes

两条 daemon 修复，都是「daemon 看起来健康、实际什么都没做」的形状。

- **stop/delete 发信号发的是解析出的真 pgid，不再假设 `pgid == pid`**（PR #1480，修 #1474 finding-2）。
  `sendGroupSignal` 做的是 `kill(-recorded.pid)`。live 路径上这确实成立（spawn wrapper 时
  `detached` → setsid → wrapper 是 session leader）。但 **boot rebuild 走 `pgrep` 找到的是孙子进程**，
  孙子继承 wrapper 的 pgid、`孙子.pid ≠ pgid` —— daemon 重启后 `entry.pid` 记的就是孙子。
  于是 `kill(-孙子pid)` 命中一个**不存在的进程组** → `ESRCH` → 被当成"组已经没了"静默返回 →
  wrapper 和孙子**都没收到信号**。表现是 stop/delete 报成功而进程还在跑。
- **Windows 上 `anet_bin` 路径校验不再只认 POSIX**（PR #1489，修 #1290）。
  `loadAndVerifyAnetBin` 的第一道闸用 `pin.abs.startsWith('/')` 判断绝对路径 ——
  Windows 的绝对路径是 `C:\...`，永远不以 `/` 开头，于是**每一个 Windows daemon 的 `create_node`
  都抛 `anet_bin_unsafe_path: not absolute: C:\...`**。而 daemon 本身看着是健康的
  （SSE 正常、门铃收到、hub 那边 `ok:true`），只是**一个节点都没 fork 出来**。
  现在用 `path.isAbsolute()`；Windows 上另加大小写无关的 realpath 等价判断
  （junction / 大小写归一化过的 realpath 不该在第二道闸被拒）；POSIX 专属的三道模式闸
  在 Windows 上跳过并每进程警告一次。

🔴 这两条和 #1137（agent-network `2.3.0-preview.66`）是**同一类**：代码里写着只在 POSIX 成立的假设，
而它也要在 Windows 上跑。Windows 用户请两个包一起升。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.66 @sleep2agi/agent-node@2.5.0-preview.51
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.51
cd ~/anodes && anet project restart
```

跑着的节点要重启才会拿到新 agent-node（#117）。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1480 | #1474 finding-2 | stop/delete 发解析出的真 pgid，不假设 `pgid == pid` |
| #1489 | #1290 | Windows 上 `anet_bin` 绝对路径校验（`path.isAbsolute` + 大小写无关 realpath 等价） |

**注意 issue 编号容易串**：#1474 finding-1（删节点后密钥残留，PR #1478）已在 `2.5.0-preview.50`；
本版是 finding-2。而 #1469 finding-2 是另一码事（network_id），在 agent-network `2.3.0-preview.65` 里。
