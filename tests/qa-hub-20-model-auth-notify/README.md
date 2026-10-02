# qa-hub-20-model-auth-notify — 节点登录失效通知节点主人(#462)

真 hub(全新 HOME + DB,随机端口),全部走 REST / MCP HTTP:

1. boss 注册(网络 owner);nora、otto 经邀请入网并放开 `agent_access=all`;nora 铸 `node-a` 的节点令牌
   (于是 nora 是节点主人)。
2. 用节点令牌 `report_status`,`health.model_auth` 依次为 ok → expired → expired → ok → expired。
3. `GET /api/messages?scope=user`(App 读未读的同一个口):nora 恰好 2 条 `kind=node_model_auth`、
   `from_session=node-a`;boss 与 otto 0 条。正文带节点别名、原因、`codex login` 修法;计入 `unread_by_agent`。
4. witnessed-red:把去重那一行改掉、换一个全新 hub 重跑同一序列 ⇒ 3 条(第 3 步的断言会红)。

跑法(仓库根):

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-20-model-auth-notify -f tests/qa-hub-20-model-auth-notify/Dockerfile .
docker run --rm anet-qa-hub-20-model-auth-notify
```

CI:`.github/workflows/qa.yml` 的 `hub-orphan-gates` matrix。单测见 `server/src/model-auth-notify-http.test.ts`。
