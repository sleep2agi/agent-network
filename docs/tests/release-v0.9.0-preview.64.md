# CommHub v0.9.0-preview.64

本次小版本准备交付：按网络隔离的需求池、卡片状态和 GitHub issue 关联，
以及人类/Agent 负责人和参与人的稳定身份绑定。卡片不是正在执行的节点 tasks，
绑定 Agent 不会自动派单；节点令牌本版仍不能使用需求池接口。

身份绑定 PR #2065 已合入 main（524b30f4e5b4c0e5816550fc7e6c8738bd3fbbdd）。本说明不是已发布证明。
main 的 server/package.json 实际版本为 preview.64；此前误用 preview.63 参数的
Actions run 36408927591 被安装版本检查拒绝，publish 跳过，没有发布该错误版本。
只从包含该实现的 main 完整 SHA 运行 release.yml，并保持 preview 通道。

## Install

在获准安装的独立环境中安装精确版本（Hub 运行需要 Bun）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.64
```

启动、密钥和数据目录沿用仓库部署说明；不要把此命令当作生产变更授权。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.64
```

已有实例由运维在授权窗口备份数据库后按原服务管理方式重启。新增表和列为
增量迁移；软件包不包含已有需求数据、用户、网络成员或密钥。
回滚使用原精确版本和预先准备的数据恢复方案，不删除生产表或覆盖已发布包。
本轮发布不自动升级生产 Hub，不操作 TM 节点。

客户端也必须包含对应 UI；仅升级 Hub 不会让旧客户端出现人员选择器。
客户端内置 Hub 的锁定依赖应在本包确实发布后更新，不能指向未发布版本。
旧 Hub 缺少接口时，新客户端提示升级，不退回本机另存一份需求。

## 验证边界

源码侧 Docker HTTP 用例覆盖网络隔离、只读拒绝、人员身份校验、状态持久化
和 issue 绑定；对应报告见 report-test-requirement-assignments.txt。
这不是生产验收或 PostgreSQL 端到端证据。
正式发布后还需核实 npm 精确版本、实际包内 requirements 实现，并以发布包
完成一次隔离环境创建/读取/人员绑定验证。未完成前不宣称用户已可用。
