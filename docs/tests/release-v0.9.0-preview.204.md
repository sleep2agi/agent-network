# 0.9.0-preview.204

> 空数组不再"猜"：`[]` 拒收，清空请传 `null`。

## 本版

```
PUT /api/nodes/{id}/tool-allowlist   {"tools": []}   → 400 empty_allowlist_ambiguous
PUT /api/nodes/{id}/peer-allowlist   {"peers": []}   → 400 empty_allowlist_ambiguous
PUT ...                              null            → 200，清空（= 不限制）
```

语义收敛成三句话：

```
null      = 不限制
非空数组  = 只允许名单里的
[]        = 400，拒收
```

`GET /api/nodes` 只返回 `null` 或非空数组，永远不返回 `[]`。

## 为什么不把 `[]` 当「禁止一切」

客户端曾经把「`[]` = 不允许任何工具」做进界面，而 Hub 把 `[]` 规范化成 `null` = 不限制 ——
**界面说收紧了，系统其实放开了**。三种做法里选了唯一不会产生静默行为的一种：

| 做法 | 后果 |
|---|---|
| `[]` = 禁止一切 | 老客户端（传 `[]` 表示清空）的按钮会当场把节点封死 |
| `[]` = null（原状） | 界面可以无声地宣称「全部禁止」而实际全放开 |
| 拒收 `[]`（本版） | 调用方当场看到 400，没有静默行为 |

## 另一处（不影响运行时）

发布门不会再因为 npm 的 `TLOG_CREATE_ENTRY_ERROR (409)` 判红 —— 那是「透明度日志已记录」，
不是「被拒绝」。现在失败时先分类，成败交给「发后核实」（轮询 registry + tag/shasum 比对）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version     # 0.9.0-preview.204

curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:9200/api/nodes/n_x/tool-allowlist \
  -H "Authorization: Bearer <user-token>" -H 'Content-Type: application/json' -d '{"tools":[]}'
# 期望 400（节点不存在时也先是 400 —— 空数组在鉴权之后、查节点之前就被拒）
```

## 兼容性

无 schema 变更。只有「传空数组」这一种原本就歧义的输入被明确拒掉；`null` 与数组的行为不变。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.204
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.203`。
