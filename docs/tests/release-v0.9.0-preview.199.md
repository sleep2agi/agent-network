# 0.9.0-preview.199

> 移除许可 / 激活码体系：这个项目是纯开源软件，没有「额度」这件事。

## 移除内容

```
GET  /api/license            → 删除（返回 404）
POST /api/license/activate   → 删除（返回 404）
```

`POST /api/license/activate` 曾是**完全没有鉴权**的写入口：任何能访问 Hub 的人（含未登录）POST 一个 `anet-` 开头的串，它会先 `DELETE FROM licenses` 再写一条新的。

## 更要紧的一处

`send_task` 里还留着一条许可检查：

```
SELECT type, expires_at FROM licenses ORDER BY created_at LIMIT 1
若已过期 → { ok:false, error:"license_expired", message:"Trial expired…" }
```

生产库实测有一条 `type=pro`、`expires_at=2027-05-25` 的记录。**不删这条检查，2027-05-25 那天这台 Hub 会在没有任何改动的情况下突然停止派活**，而界面上只会显示 "Trial expired"。本版一并删除。

## 其它

```
首次启动不再插入 14 天 trial（那一行从来没人读，只是给新库凭空多一行死数据）
anet license / anet activate 命令名保留，直接打印「功能已移除」并返回 0
  —— 删命令会让已有脚本拿到 unknown command（退出码 2）
licenses 表留在库里但不再读写（历史行不删，避免迁移风险）
```

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version     # 0.9.0-preview.199
curl -s -o /dev/null -w '%{http_code}\n' localhost:9200/api/license        # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:9200/api/license/activate  # 404
```

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.198`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.199
commhub-server --version   # 0.9.0-preview.199
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.199
commhub-server --version   # 0.9.0-preview.199
```
