# agent-node 2.5.0-preview.216

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.250** 精确配对。

## Why

修正 `.215` 里浏览器能力的两处**真机问题**（`.215` 已发，本版是修正版）：

```text
① SKILL.md 教的是 `browser-use text` —— agent-browser 没有裸 `text` 子命令（实测 Unknown command）
   ⇒ 改为 `browser-use get text body`
② 原 wrapper 每次调用先 `agent-browser close`，且只在 `open` 上带 --args
   ⇒ 关掉之后下一条命令（get text / screenshot）重新启动浏览器时**没有 --no-sandbox**
      （实测 FATAL: No usable sandbox）
   ⇒ 改为：不再主动 close；参数放在子命令之前且每条命令都带
      （daemon 已在跑时会打一行「--args ignored」，退出码 0，不影响结果）
```

## 本机 Linux 实测（真实链路）

```text
· installBrowserUseSkill 铺到临时节点目录 → .agents/skills + .claude/skills + .anet/bin/browser-use(0755)
· browser-use open https://example.com  → ✓ Example Domain
· browser-use get text body              → 拿到正文
· BROWSER_USE_ALLOWED_DOMAINS=example.com browser-use open https://evil.test → 被拒
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.216 @sleep2agi/agent-network@2.3.0-preview.250
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

```text
· macOS / Windows 实机（Windows 白名单仍**故意不强制**，等真机再补）
```
