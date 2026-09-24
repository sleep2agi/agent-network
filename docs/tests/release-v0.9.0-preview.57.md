# `@sleep2agi/commhub-server@0.9.0-preview.57`

## 为什么发这一版:**节点技能只读查看**(#1984)

`.56` 之后 `server/src` 一个功能提交:

| 提交 | PR | 内容 |
|---|---|---|
| ecf2564c | #1984 | 节点「技能」只读查看:hub `list_node_skills` / `read_node_skill`(复用规则文件门铃与请求表,op `skills_list` / `skill_read`),agent-node 与 Claude Code 通道按各运行时真实加载位置列出技能,上报 `skills_capable` |

- 新 MCP 工具 `list_node_skills {node_id|alias}`、`read_node_skill {node_id|alias, name}`;在 `node_rules_requests` 上排 `skills_list` / `skill_read`,与规则文件同一套网络/身份校验;技能有自己的单飞通道,不被待处理的规则文件请求挡住。
- 只收技能**名**不收路径,坏名在写行之前就拒;`sessions.skills_capable` 只在调用者 token 与该 alias 绑定时写入(不重复 #1982 的越权形态)。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.57
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.57
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

节点侧配套 `agent-network@2.3.0-preview.112` + `agent-node@2.5.0-preview.85`;客户端 0.2.87 起在节点页「技能」区显示。

## 证据

- hub 新增 7 条测试(origin/main 上 0/7;两处变异各红 1);hub 全量 110 个测试文件按 CI 方式全过。
- 一次性 hub 端到端 10/10:两条路径列出与读取、SKILL.md 字节一致;符号链接逃逸 / 未知名 / `../CLAUDE.md` 都干净拒绝;去掉包含检查时逃逸技能出现在列表里 ⇒ 门有效。

## promote 时的 must_contain

`"version": "0.9.0-preview.57"`
