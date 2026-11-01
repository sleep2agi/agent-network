# commhub-server 0.9.0-preview.265

Since `.264`: 保险库的值可以**流向**指定节点（`node_secret_put` 的 `provider.from_vault`），
但任何人仍然**读不出来**。

## Why

admin 2026-11-01 在客户端里撞到的死结（TMA客户端欧2号 的原话）：保险库里确实有 `TMPAT`，
但它拿不到值 —— RFC-028 的保险库是「只进不出」，`list_network_secrets` 只回键名，没有取值接口。

**这个设计是对的**：给 agent 一个读口，等于把整个网络的密钥变成任何一次 prompt 注入都能 dump 的东西。
但它留下一个真实的坑：密钥进了保险库，却**没有任何路径**把它送到真正要用的那个进程。
于是人只剩两条更差的路 —— 把明文再复制一遍，或者写进工作区文件。

## What changed

`node_secret_put` 增加 `provider.from_vault: true`：

```jsonc
{ "action": "node_secret_put", "id": "n_xxx", "revision": 0,
  "provider": { "key": "TMPAT", "from_vault": true } }   // 不提供 value
```

Hub 从保险库取出该键的值，写进这次下发请求；节点下次 `pull` 时拿到它，写进
`<nodeDir>/node-secrets.json`（0600），**下次启动**进进程 env（`activation: next_start`）。

三条边界：

1. **只有 owner/admin 能发**（`secret_admin_required`）；节点令牌自己调是 `user_token_required`
   —— 机器不能给自己发密钥。
2. **读侧仍然没有值**：`getScopedSecrets` 的回执只有 status/snapshot/error；节点 ack 回来的
   snapshot 里只有 `{key, source}`。第二条由测试的反向断言钉住。
3. 保险库里没有这个键 ⇒ `vault_key_missing`（不回一个看起来成功的请求），
   且 `from_vault` 与 `value` 同时给 ⇒ `invalid_secret_input`（说不清写进去的是哪一个）。
   审计里记的是 `node_secret_put_from_vault`（记来源，不记值）。

## Verification

```text
server/src/node-secret-vault-inject.test.ts  9 pass
  ① 流向：owner 只给键名 ⇒ 节点 pull 到的那条请求里带着保险库的值
  ② 读权：ack / getScopedSecrets 的回执里都没有值（含 JSON 里不存在 "value" 键的镜像断言）
  · vault_key_missing / list+from_vault / delete+from_vault / value+from_vault 同时给
  · 普通成员 ⇒ secret_admin_required；节点令牌 ⇒ user_token_required；旧节点 ⇒ node_secrets_upgrade_required

witness A：把 fromVaultValue 丢掉 ⇒ 3 例红（同一条创建请求的三种断言，记连坐）
witness B：让 getScopedSecrets 回 value ⇒ **只有**镜像否定那 1 例红（可隔离判别力）
```

## What it does not do

- 不开任何「读密钥」的接口 —— 方向是「推进进程」，不是「取出来」。
- 不做 daemon 车道（`secret_put` + `from_vault`）：那条要 daemon 侧同步支持，留作下一张卡。
- 值仍然只在**下次启动**生效（`activation: next_start`），不是热注入。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.265
```

## Upgrade

```bash
anet hub upgrade
```
