# qa-hub-23-node-permissions — 节点自己的权限,第一阶段:先记录、后执行(RFC-041,#487)

真 hub(全新 HOME + DB,随机端口),全部走 REST / MCP HTTP:

1. **默认(`COMMHUB_NODE_PERMISSIONS` 不设 = `log`)**:boss 给 `node-a`(正常)、`node-r`(受限)、`node-o`(只读)、`node-x` 铸令牌并上报心跳;
   两张卡:一张负责 Agent 是 `node-r`,一张只有 boss。模式用 `PUT /api/nodes/:id/permission-mode` 设。
   - `node-a` 改 `node-x` 的属性(只有人能做的事)—— **照常 200**,只记录。
   - `node-o` 写卡 / 派活 → 403 `node_permission_denied`(`mode_readonly` + hint);心跳照常。
   - `node-r` 列表只有派给它的那张;能改那张;看不见另一张(404);广播被拒。
   - `GET /api/networks/:id/node-permission-report`:owner 看到 `node-a` 的 `human_only`、`node-o` 的 `mode_readonly` 计数;节点令牌 403。
2. **`enforce`**:同一个「改别的节点」→ 403 `human_only`;改自己的属性、正常派活照常。
3. **witnessed-red**:把 `nodeDecide` 改成永远放行,换全新 hub 重跑 ⇒ 只读节点的写穿过去(第 1 步会红)。

跑法(仓库根):

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-23-node-permissions -f tests/qa-hub-23-node-permissions/Dockerfile .
docker run --rm anet-qa-hub-23-node-permissions
```

CI:`.github/workflows/qa.yml` 的 `hub-orphan-gates` matrix。单测见 `server/src/node-permissions-http.test.ts`。
