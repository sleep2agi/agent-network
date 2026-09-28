# CommHub v0.9.0-preview.65

已有需求可以用 PATCH 修改标题、优先级、期限和旧的 assignee 文本。
没写进请求的字段保持原样，包括负责人和参与人。空字符串清空期限和 assignee。
这不是新的权限：仍按原网络角色判断，viewer 不能写，节点令牌仍不能用需求池。

实现在 main 的 #2070（f327cf72c501d03392049dd8f7cb46836b844278）。
本说明不是已发布证明。只从包含这次改动的 main 完整 SHA 运行 release.yml，
包名 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.65`，通道 preview。

## Install

在获准安装的独立环境中安装精确版本（Hub 运行需要 Bun）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.65
```

启动、密钥和数据目录沿用仓库部署说明。不要把安装命令本身当成已经切换了生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.65
```

已有实例由运维在授权窗口备份数据库后按原服务管理方式重启。这次不新增表，
只改变已有需求行的更新语句。软件包不包含已有需求数据、用户、网络成员或密钥。
回滚使用 `0.9.0-preview.64` 和预先准备的数据恢复方案，不删除生产表，不覆盖已发布包。

仅升级 Hub 不会让旧客户端出现「保存修改」。客户端要另发一版才有编辑界面。
旧 Hub 收到这些字段会返回 empty_patch，新客户端应提示还不能改，而不是另存一份。
