# agent-node 2.5.0-preview.212

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.244** 精确配对。

## Why

三笔，都是 agy（Antigravity）在 native Windows 上落地的最后一段路：

1. **跨任务会话持久化**（#3727）—— agy 节点重启 / 下一轮任务会接着同一个 session，
   第二轮能答对上一轮的口令（负责人真机验证；agent-node 全量 3614 pass / 0 fail）。
2. **Windows 放行 ACP stdio（默认仍关）**（#3728）—— RFC-044 slice 2 当初的边界是
   「PTY/tmux/co-presence」，但实现写成了「win32 只允许 claude-agent-sdk」，把 ACP stdio
   一起挡了。现在 `antigravity-acp` 只在 `ANET_ALLOW_ACP_WINDOWS=1`（字面 1）时放行；
   TUI / co-presence / 其它运行时仍然挡。默认行为不变。
3. **Windows 子进程 PATH 补全**（#3729）—— 计划任务 / 服务启动的进程 PATH 常缺
   `C:\Windows\System32\WindowsPowerShell\v1.0`，agy 的 shell 工具报
   `exec: powershell not found`。现在 ACP spawn 与 agy 探活都会补 System32 与
   PowerShell（用 `SystemRoot`/`windir` 推导，不写死盘符；已在 PATH 的条目大小写不敏感去重）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.212 @sleep2agi/agent-network@2.3.0-preview.244
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未覆盖（不写「已支持」）

```text
· Windows 上走 daemon 自己的 stop 流程后「无残留 agy 子进程」还没有真机证据
  ⇒ antigravity-acp 在 Windows 仍保持 opt-in（ANET_ALLOW_ACP_WINDOWS=1），不默认放行
· 该开关只在 daemon 进程环境生效；CLI 侧同一条断言，两边要一起设
```
