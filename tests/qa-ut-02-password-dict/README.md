# qa-ut-02-password-dict

**Matrix cell**: [UT-02](../../docs/qa/test-matrix.md#代码视角l0-单测补丁清单) — `server/src/password-dict.ts` weak-password set.

**Layer**: L0 unit（代码视角，pure data + computed set）。

**Why it matters**: 是 [test30 step 3](../test30-v0.8-auth-deprecation) 已端到端覆盖的逻辑，
补一层 ms 级单测，PR 改 dict 文件能秒拦截 regression — 不必等慢的 E2E 跑完。

## Run

### Local dev (preferred, ~55ms)

```bash
cd server && bun test src/password-dict.test.ts
```

### Docker (CI / 全平台一致性)

```bash
sg docker -c 'docker build -t anet-qa-ut-02 -f tests/qa-ut-02-password-dict/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-ut-02'
```

预算：local ~55ms，Docker cold ~10s，warm ~2s。

## 19 个断言覆盖

| 组 | 断言 |
|----|------|
| 常见弱密码 | `123456` / `password` / `qwerty` / `admin` / `letmein` / `iloveyou` / `passw0rd` 全在 |
| 生成家族 — 6 位补零数字 | `000000` / `000042` / `000999` 在 |
| 生成家族 — passwordN | N=0/42/999 在 |
| 生成家族 — qwertyN | N=0/999 在 |
| 大小写契约 | Set 只存 lowercase；调用方需先 `.toLowerCase()`（pin auth.ts L26 行为） |
| 强密码必须不在 | `StrongPassw0rd` / `correct horse battery` / `Tr0ub4dor&3` 等 5 条全不在 |
| 大小 sanity | Set.size > 3000（89 字面 + 1000+1000+1000 三家族） |

## 资源

- 本地：bun 1.x
- Docker：`oven/bun:1` 镜像（约 200MB）

**不需要**：网络、commhub-server 源码（test 文件只 import dict 自身）、其它 server/src/* 文件、DB。
