# qa-hub-22-department-heads — 部门负责人权限(RFC-040,#455)

真 hub(全新 HOME + DB,随机端口),全部走 REST:

1. owner(第一个注册 = Hub 管理员)建组织架构:研发(上级负责人)› 前端(负责人)› 前端一组;销售。
   负责人、上级负责人、成员、销售都是「只看相关任务」(scoped)。成员负责一张卡,销售负责一张卡(在项目 P 里)。
2. `/api/auth/me` 的 `managed_department_ids` = 前端 + 前端一组。
3. 负责人在本部门下建子部门 201;建到销售下 403 `department_scope_denied`;普通成员仍是逐字节相同的
   `{"ok":false,"error":"owner/admin required"}`。
4. 负责人看得见成员的卡、看不见销售的卡;上级负责人看得见孙部门的卡。
5. 撤掉负责人 → 下一次请求就看不见;恢复后又看得见。
6. 项目 P 授权给研发 → 前端一组的成员看得见 P 里的卡;负责人改不了部门项目授权(403)。
7. 负责人删成员的卡 → 成员收到私信。
8. witnessed-red:把「负责人管整棵子树」改成「只管自己那一层」,换全新 hub 重跑 ⇒ 上级负责人看不见孙部门的卡(第 4 步会红)。

逐条矩阵(owner / admin / 负责人 / 上级负责人 / 成员 / viewer)在 `server/src/department-heads-http.test.ts`,
SQLite 走 server 测试聚合,PG 走 `tests/test2123-hub-postgres-ladder`。

跑法(仓库根):

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-22-department-heads -f tests/qa-hub-22-department-heads/Dockerfile .
docker run --rm anet-qa-hub-22-department-heads
```
