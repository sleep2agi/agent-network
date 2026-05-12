# qa-ut-01-auth-tokens

**Matrix cell**: [UT-01](../../docs/qa/test-matrix.md#代码视角l0-单测补丁清单) — `server/src/db.ts` token generation + hashing 纯函数。

**Layer**: L0 unit（代码视角，纯函数，ms 级）。

**Why it matters**: utok_ / ntok_ / atok_ 三种 token + hashPassword 是双 token 体系的最底层原语。
[R5 (HUB-06)](../qa-hub-06-token-revoke/) 在 E2E 层覆盖了**撤销**，但**生成/解析的形状边界**没有快速断言。
改 db.ts 生成函数的 PR 用这条 ms 级单测能秒拦截 — 不必等慢的 L1。

## Run

### Local dev (preferred, ~250ms)

```bash
COMMHUB_DB=/tmp/qa-ut-01-local.db cd server && bun test src/auth-tokens.test.ts
```

### Docker (CI / 一致性)

```bash
sg docker -c 'docker build -t anet-qa-ut-01 -f tests/qa-ut-01-auth-tokens/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-ut-01'
```

预算：local ~250ms（含 db schema bootstrap），Docker warm ~1s。

## 19 个断言

| 组 | 断言 |
|----|------|
| uuidv4 | RFC 4122 v4 shape × 50 / 1000 个全 unique |
| generateId(prefix) | `<prefix>_<12hex>` 形状 + 多 prefix |
| token generators 形状 | `atok_<32hex>` / `utok_<32hex>` / `ntok_<32hex>` |
| token prefix 区分 | utok / ntok / atok 互不前缀冲突 |
| token uniqueness | 1000 个 generate 全 unique（×3 种） |
| hashToken 性质 | 64-char hex / 确定性 / 类似输入≠相同输出 / 已知 fixture `sha256('test')` |
| hashPassword 性质 | 64-char hex / 确定性 / **'anet:' salt 契约**（`hashPassword(x) == hashToken('anet:'+x)`）|
| 安全性 | hashToken(prefix) ≠ hashToken(full) — 防止意外只 hash 前缀 |

## 关键断言（pin 协议契约）

**hashPassword 用 'anet:' 前缀做 salt** — 如果有人重构 db.ts 不小心把这个 salt 丢了，
所有已存的用户密码 hash 就**静默失效**（新登录都对不上）。这条测试用：
```ts
expect(hashPassword("foo")).toBe(hashToken("anet:foo"));
```
锁死契约。

## 资源

- bun 1.x（`oven/bun:1` ~200MB）
- `COMMHUB_DB=/tmp/...` 让 db.ts schema bootstrap 写到 throwaway 文件
- **不需要**网络、commhub 进程、真 LLM
