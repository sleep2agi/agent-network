# qa-ut-03-auth-validate

**Matrix cell**: UT-03（新增）— `server/src/auth.ts` `register()` username + password validation。

**Layer**: L0 unit（代码视角，~290ms）。

**Why it matters**: 弱密码漏过 = 撞库账号。username 规则 = 注入 / Unicode 攻击面。
[test30 step 3](../test30-v0.8-auth-deprecation) E2E 只测 2 个弱密码，UT-03 测 14+ 个 + 边界。

`validatePasswordStrength` 是 auth.ts 内部函数没 export，所以通过 user-facing 的 `register()` 测，
这也是真实的契约面（用户能感知的拒绝消息）。

## Run

```bash
# local
cd server && COMMHUB_DB=/tmp/qa-ut-03.db bun test src/auth-validate.test.ts

# Docker
sg docker -c 'docker build -t anet-qa-ut-03 -f tests/qa-ut-03-auth-validate/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-ut-03'
```

预算：local ~290ms，Docker warm ~1s。

## 23 个断言

| 组 | 内容 |
|----|------|
| Username 规则 | 空 / 1 char / 2 char / 51 char / 含空格 / 含 `@` / **中文 CJK** / 重复 |
| Password 长度 | 空 / 7 char / 8 char OK |
| 弱密码字典 | `password` / `passw0rd` / `iloveyou` / `password1` / `qwerty12` |
| 大小写契约 | `PASSWORD` / `Password1` 也拒（dict lookup 用 toLowerCase） |
| 强密码通过 | `Tr0ub4dor&3` / `correct-horse-battery` / `X9!kLm@PqVx` 等 |
| **admin bootstrap 旁路契约** | first user 走宽松路径（min 4 chars），第二个用户开始严格；这条 pin 严格路径开启 |

## 关键契约锁死

#### 1. First-user relaxed rules

[auth.ts L41-46](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L41) 第一个用户（admin bootstrap）走宽松检查（min 4 chars，不查 dict）。
这是 `anet hub start --password anethub` 这种快速启动的便利通道。

测试用 beforeAll 先 seed 一个 admin，确保后续测试走严格路径。
4-char 在严格路径必拒 → 反证宽松路径只对 first user 生效。

#### 2. CJK username 合法

[auth.ts L34](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L34) regex `[a-zA-Z0-9_\-一-鿿]+`。
中文 alias（"通信测试马" 等）能注册。这是项目刻意支持的功能，pin 住别被新 regex 误删。

#### 3. 弱密码大小写不敏感

[auth.ts L26](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L26) `WEAK_PASSWORDS.has(password.toLowerCase())`。
攻击者用 `PASSWORD` / `Password1` 想绕字典 → 这条断言锁死 toLowerCase 步骤。

## 资源

- bun 1.x (`oven/bun:1` ~200MB)
- `COMMHUB_DB=/tmp/...` 把 schema bootstrap 路由到 throwaway
- **不需要**：commhub-server 进程、网络、real LLM
