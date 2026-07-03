# anet 发布管理

本目录管理 anet 的版本发布。

## 结构

- **`versioning-and-compatibility.md`** — 跨版本 **living 参考**：三个 npm 包（agent-network / agent-node / commhub-server）的依赖契约（npm 解耦、运行时耦合）、版本兼容矩阵、bump-together 规则。每次发版对照更新。
- **`v<agent-network 版本>/`** — 每个**正式版本（GA）里程碑一个文件夹**，里面：
  - `plan.md` — 该里程碑的主题 / 已合进 main / GA 前 TODO / preview 发布节奏 / 切 latest 门槛 / 滚动 changelog。
  - 当前：**[`v2.3.0/`](v2.3.0/plan.md)**（= agent-node 2.5.0 + commhub 0.9.0）

## 新里程碑怎么开

1. 复制上一个 `vX.Y.Z/plan.md` 作模板，新建 `v<下一个 agent-network 版本>/plan.md`。
2. 填主题 + 已合 + TODO + preview 节奏。
3. 版本耦合（哪几个包一起升）查 `versioning-and-compatibility.md` §3/§5。

## 原则

- 先 preview 小步发，每发带实质更新 + 一句 changelog。
- latest 严格两阶段：preview 亲测 + 30min 观察窗口，且兼容矩阵「整行」四包一起测绿才升。
