# 0.9.0-preview.215

> 一个回显字段：`200` 不再「不说自己是谁的网络」。

## 三条静默（两个独立复核拼出来的）

```
① 用户令牌 + 非成员 network_id      → 200 + 空数组
② 用户令牌属于多网络、不带 network_id → 400 network_id_required   ← #2899 当时的真因
③ 节点令牌 + 任意 network_id         → 200 + 它自己网络的数据
```

③ 最危险：客户端以为在看 A 的项目，实际拿到 B 的（自己的）。
三条共同点：**响应码不携带「你问的是不是这个网络」**。

## 改法

```json
GET /api/requirements/projects?network_id=<任意>
→ { "ok": true, "network_id": "<实际使用的那个>", "projects": [...] }
```

- 不改鉴权、不改返回内容、不引入新的 4xx —— 纯增量字段
- 调用方拿 `network_id` 与自己请求的比对即可发现不一致
- 没有做 403 收紧：那会影响所有客户端与 MCP 调用方，需要先有跨端兼容验证

## 测试

```
requirements-projects-network-echo：3 pass
  · owner 带 network_id → 回显之
  · 不带 network_id（单一成员自动推断）→ 回显推断值
  · 节点令牌传别人的 id → 回显它自己的网络（调用方据此判定不一致）
preflight 54 passed
```

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.215
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.215
# 或在部署机重启 hub 后核对 /health 的 version == 0.9.0-preview.215
```
