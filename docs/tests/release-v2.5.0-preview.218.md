# agent-node 2.5.0-preview.218

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.252** 精确配对。

## Why

**OpenCode V2 思考档位持久化**（`#5123`，`#3757`）：

```text
· 切换成功（回读确认 applied）后写回 config.json 的 modelVariant（tmp + rename 原子替换）
· rejected / unknown 一律不写 —— unknown 落盘会制造「配置说切了、会话没切」的谎，比不持久化更坏
· variant=null（回到默认档）→ 删除该键，而不是写 null
· 启动恢复：会话 running 后比较「配置里想要的档位」与「会话当前档位」，不同才调一次；
  busy / unsupported 只记一行，不重试；任何异常都不阻断启动
· 语义：档位与 model 同级（节点配置）；旧节点忽略该键 ⇒ 降级为会话级，不报错
· 共享 OpenCode server 多节点并发启动：按「最后一写者生效」处理（代码里无可靠并发闸门）
```

## 验证

```text
· variant-persist 单测 7 pass：只有 applied 才写 / null 删键 / 原子替换 / 非法档位拒绝写 /
  读失败只 warn / 启动三态 / id 形状
· 回归 variant-config-apply 21 pass；bun build src/cli.ts 通过
```

## 未验

```text
· 真机：切换档位 → 重启节点 → 档位仍在（需要一台 opencode-cli V2 节点）
· 共享 server 并发启动的相互覆盖行为
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.218 @sleep2agi/agent-network@2.3.0-preview.252
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```
