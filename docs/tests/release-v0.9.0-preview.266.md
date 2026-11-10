# commhub-server 0.9.0-preview.266

Since `.265`: 新增**部门维度授权** —— 给某个用户授权一个部门，他就能看到该部门（含全部下级）
下所有节点的 Agent 卡片。

## Why

admin 2026-11-05 问：「现在给某个用户授权 有权限看 某个组织架构下的所有节点，这个功能做了吗？」

查下来是**两条轴**：

```text
Agent 侧（已做）  agent_groups + group_grants：授权一个组 ⇒ 该组此刻的成员节点可见（现算展开）
人的组织架构（没做）network_departments + nodes.department_id：可见性判据里没有这一档
```

于是「按部门授权」只能靠人手把这些节点收进一个组 —— 部门一变就得重新收。

## What changed

`PUT /api/networks/<net>/members/<uid>/agent-grants` 新增 `department_grants`：

```jsonc
{ "department_grants": [ { "department_id": "d_xxx", "can_message": true } ] }
```

语义与组授权完全同构，只有展开源不同：`departmentSubtree(dept)` → `nodes.department_id ∈ 子树`。
**每次请求现算**：部门里新挂的节点，下一次请求就可见；撤掉授权立刻看不见。

`GET` 同一路由新增两格：

```text
department_grants    该成员被授权的部门（含部门名）
department_coverage  { nodes_total, nodes_with_department, nodes_without_department }
```

## 为什么必须带 coverage

`nodes.department_id` 目前只有 41% 的节点填了（生产：318 个里 133 个）。
**没填部门的节点永远不可能被部门授权覆盖** —— 不把这个数摆出来，用户会以为「授权了就该全看见」，
然后在界面上找不到人，再报一个「授权不生效」的 bug。

## Verification

```text
server/src/agent-department-grants.test.ts  8 pass
  ① 授权 root ⇒ root 自己 + 下级 child 里的节点都可见
  ② 镜像否定：没填部门的节点、别的部门的节点都不出现
  · can_message 逐部门传递（false 不影响另一个 true）
  · 撤掉授权立刻看不见；部门里新挂节点下一次请求可见
  · 不在本网络的部门 ⇒ department_not_in_network（整批拒绝，不静默忽略）
  · undefined 不清空已有部门授权（旧客户端的 PUT 不带这个键）
witness A：visibleAgents 去掉部门那一路 ⇒ 1 例红（可隔离）
witness B：展开不做子树 ⇒ 3 例红（同一子树语义的三种断言，记连坐）
```

## What it does not do

- 不自动给「部门负责人」开权限（负责人那套是 `department-heads.ts` 的写权限，不是可见性）。
- 不改 `agent_access` 三档（all / granted / 逐 Agent + 组）；部门授权只是 `granted` 下的第八种来源。
- 不填 `nodes.department_id`；覆盖率靠人补齐。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.266
```

## Upgrade

```bash
anet hub upgrade
```
