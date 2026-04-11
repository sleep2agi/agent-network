# test9 review

目标文件：`tests/test9-permissions/run.sh`

## 结论

这个脚本能覆盖一部分基础权限边界，但覆盖面不完整，尤其缺少 `admin` 角色、读权限矩阵、角色变更类管理操作，以及跨网络角色组合。当前断言里还有几处实现耦合和脆弱匹配，容易出现假阳性或假阴性。

## 1. 角色权限覆盖是否完整

不完整。现在实际覆盖到的只有：

- `viewer`：
  - 不能通过 MCP `send_task`
  - 不能创建 node token
- `member`：
  - 能通过 MCP `send_task`
  - 不能创建 invite
  - 不能移除成员
- `owner`：
  - 能通过 MCP `send_task`
  - 能创建 node token
  - 能移除成员

缺失项比较明显：

- 完全没测 `admin` 角色
- 没有系统性覆盖“读 / 写 / 管理”三类操作
- 没测角色变更接口 `PUT /api/networks/:id/members/:uid`
- 没测 `GET /api/networks/:id/members` 的可见性
- 没测 `GET /api/networks/:id`、`/api/status`、`/api/tasks` 这类读接口的角色差异
- 没测 `admin` 创建 invite
- 没测 `admin` 删除成员
- 没测 `member` 创建 node token
  - 按当前服务端实现，`member` 是允许创建 network token 的，脚本没有覆盖这条规则
- 没测 owner/admin/member/viewer 对同一操作的完整矩阵

## 2. 断言是否正确

有几处断言不够稳。

### 2.1 MCP 响应断言过于脆弱

脚本直接对 `send_task_mcp` 返回文本做 `grep`：

- viewer：检查 `ok\":true` 不应出现
- member/owner：检查 `ok\":false` 不应出现

这个写法依赖具体序列化格式。只要 MCP 输出格式、转义方式、SSE 包装、日志前缀稍变，断言就可能误判。更稳的方式应该是：

- 解析 JSON 字段而不是 grep 转义后的原始文本
- 或检查明确的 side effect，例如任务是否真的进入目标网络/队列

### 2.2 `send_task` 只看返回，不验证副作用

当前只判断“调用看起来成功/失败”，但没有验证：

- 任务是否真的创建成功
- 是否写入了正确网络
- 是否被错误落到了别的网络

这类权限测试如果不验副作用，容易漏掉“接口返回成功，但落库/network scope 错误”的问题。

### 2.3 quota 断言不适合作为 permissions 测试的一部分

最后一段“quota checks”在逻辑上和角色权限不是一类测试，而且断言基础不稳：

- 脚本默认认为创建 3 个额外网络后“至少一个应失败”
- 但从当前代码路径看，这个限制并不是显式、稳定、必然触发的权限规则
- 它更像 license/quota 行为，受实现和环境影响

这会导致 `test9` 同时承担“权限测试 + 配额测试”，边界不清，也容易引入不稳定失败。

建议把 quota 检查移到独立测试，不要放在 permissions 套件里。

## 3. 有没有遗漏的角色组合

有，且是主要问题。

### 3.1 缺少 `admin`

这是最大缺口。当前脚本没有把任何成员升成 `admin`，所以完全没覆盖：

- `admin` 可否创建 invite
- `admin` 可否删除成员
- `admin` 是否不能改别人角色
- `admin` 是否能读 member 列表
- `admin` 是否能创建 node token

### 3.2 缺少完整的角色矩阵

建议至少把下面这些矩阵补齐：

- 读权限：
  - owner/admin/member/viewer 对网络详情
  - owner/admin/member/viewer 对任务/状态列表
  - owner/admin/member/viewer 对成员列表
- 写权限：
  - owner/admin/member/viewer 对 `send_task`
  - owner/admin/member/viewer 对 node token 创建
- 管理权限：
  - owner/admin 对 invite 创建
  - owner/admin 对 remove member
  - 只有 owner 可改角色

### 3.3 缺少跨网络角色组合

没有测同一个用户在多个网络里角色不同的情况，例如：

- 用户 A 在网络 1 是 `owner`，在网络 2 是 `viewer`
- 用户 B 在网络 1 是 `member`，在网络 2 是 `admin`

这类组合很容易暴露“权限缓存错用”“network scope 串线”问题，当前脚本完全没覆盖。

## 4. 具体问题列表

### 高优先级

1. `admin` 角色完全未覆盖，导致管理权限矩阵不完整。
2. `send_task` 的断言只看文本，不验证副作用，无法证明权限真正生效。
3. `quota checks` 混入 permissions 测试，职责不清，且断言依据不稳定。

### 中优先级

4. 没测 `member` 创建 node token，而当前服务端实现是允许的。
5. 没测角色变更接口，只覆盖了 remove member，没有覆盖“谁能改角色”。
6. 没测读接口权限，当前更多是在测“部分写操作 + 部分管理操作”。

### 低优先级

7. 断言方式强依赖输出文本格式，后续 CLI/MCP 输出稍改就可能误报。

## 5. 建议修改方向

建议把 `test9` 重构成明确的权限矩阵测试：

- `read`：网络详情、成员列表、任务/状态查看
- `write`：`send_task`、node token 创建
- `manage`：invite、remove member、change role

每个操作都显式覆盖：

- `owner`
- `admin`
- `member`
- `viewer`

并且：

- HTTP 接口用状态码 + 响应字段双重断言
- MCP 操作用结果解析 + 副作用校验双重断言
- quota/license 行为单独拆到别的测试套件

## 最终判断

`tests/test9-permissions/run.sh` 目前只能算“部分权限冒烟测试”，不能算完整权限矩阵测试。

它能发现少量明显权限回归，但还不足以证明：

- 所有角色边界正确
- 管理权限实现完整
- 跨网络权限隔离可靠
- MCP 权限校验真正落地到了副作用层
