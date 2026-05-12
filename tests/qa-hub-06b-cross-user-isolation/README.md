# qa-hub-06b-cross-user-isolation

**Matrix cell**: HUB-06b（新增）— utok 跨用户 IDOR 边界。

**Layer**: L1 contract（黑盒 multi-user）。

**Why it matters**: SaaS-style 安全核心 —— alice / bob 两个独立用户，bob 拿自己的 utok 不能看到 alice 的 network / task / agent / message。
即使 bob 知道 alice 的 network_id（IDOR），也不能直接调 alice 的 API。

R5 (HUB-06) 测的是 token 撤销。R17 补 **跨用户隔离**，是 [OWASP IDOR](https://owasp.org/Top10/A01_2021-Broken_Access_Control/) class 防线。

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-06b -f tests/qa-hub-06b-cross-user-isolation/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-06b'
```

预算：cold ~30s，warm ~12s。

## 11 步

| # | 视角 | 断言 |
|---|------|------|
| [0-2] | setup | hub up + alice/bob 注册 + alice 建 private network + alice-agent ntok |
| [3] | alice | send_task "top-secret-alice-payload" 到 alice-agent |
| [4] | bob | `/api/networks` 不含 alice-private |
| [5] | bob | `/api/tasks` 不含 alice 的 task content |
| [6] | bob | `/api/status` 不含 alice-agent |
| [7] | bob | `/api/messages` 不含 secret 字符串 |
| [8] | **bob IDOR** | 显式 `?network_id=<alice_net>` 查询 → 没 leak alice task |
| [9] | **bob 横向 inject** | POST `/api/task` 到 alice-agent → 403 / 400 / 0 task injected |
| [10] | **bob 横向 mint** | POST `/api/auth/node-token` 到 alice 的 network → 拒 |
| [11] | alice 自检 | 自己的 network + task 还在（sanity） |

## 锁住的安全契约

#### 1. 网络成员资格作 scope

[auth.ts createNetwork](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L182)：
建网络时在 `network_members` 表写一行 owner。
[index.ts /api/networks GET](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 通过 `getUserAllNetworks(user_id)` 过滤。
bob 不是 alice-private 的成员 → 看不到。

#### 2. /api/tasks 默认按 user 可见 network 过滤

`addNetworkScope` 在所有 list 查询里 inject `WHERE network_id IN (user's networks)`。
bob 没参与 alice 的 network → 查询返空。

#### 3. 直接传 `network_id=<alice_net>` 也防住

[index.ts /api/task POST L788](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L788)：
```ts
if (restAuth && !isAdmin && !getUserNetworkRole(restAuth.userId, body.network_id)) {
  return Response.json({ ok: false, error: "access denied to requested network" }, { status: 403 });
}
```

bob 显式 IDOR 也被 `getUserNetworkRole` 拒。

#### 4. mint ntok 需要 write role on target network

[auth.ts createNetworkTokenForNode L132](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L130)：
```ts
const role = getUserNetworkRole(userId, networkId);
if (!role || role === "viewer") return { ok: false, error: "no write access to this network" };
```

bob 不是 alice-private 成员 → role=null → mint 拒。

## 资源

- Docker（`sg docker`）
- node:20-slim + bun + jq + unzip + procps
- `@sleep2agi/agent-network@preview` from npm
- 0 LLM API calls
