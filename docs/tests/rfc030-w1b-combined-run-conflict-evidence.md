# RFC-030 Wave 1B — server-boot 测试套件合跑冲突：证伪性证据

通信龙 L3 要求（task 13543df9）：证明「per-file 绿、合跑红」是环境冲突而非断言失败，
且证据可被评审牛 §8 独立复核，不由作者自证。本文件是原始合跑输出的分类 + 摘录。

## 复现命令

```
cd server && bun test src/rfc030-principal-rest.test.ts \
  src/rfc030-reply-lifecycle-e2e.test.ts \
  src/api-host-supervisors-fallback.test.ts
```

## 结论（可独立复核）

- 合跑 12 tests：1 pass / 11 fail。
- **11 个失败中 0 个是 expect() 断言失败**（`grep -c "expect(received)"` = 0）。
- 失败分两类，全部是"请求打到从未绑定的端口"：
  - 3 × `error: Unable to connect. Is the computer able to access the url?`
    （rfc030-principal-rest 的 fetch 打自己的随机端口，无人监听）
  - 8 × `this test timed out after 5000ms`（#380 套件同类，fetch 挂起到超时）
- 根因：三个套件都在 module load 时 `await import("./index")` 起 Bun.serve。
  bun test 单进程运行全部文件，`index.ts` 模块是单例——**只有第一个 importer
  的 PORT/COMMHUB_DB 生效**。本次合跑日志明确只出现一个服务器 banner：
  `database: /tmp/.../rfc030-reply-e2e-*/test.db` + `REST: http://127.0.0.1:21997`
  （reply-e2e 赢得单例），其余两个套件的端口从未监听。
- 该限制在 L1 报告时已披露，且在 baseline `d418862`（本分支之前）就存在：
  当时已有两个 importer（`uploads-http.test.ts` 与
  `api-host-supervisors-fallback.test.ts`）互斥，baseline 合跑同样 8 fail
  （与本分支合跑的 #380 8 fail 逐字一致，见 plan doc §8 证据行）。
- **Per-file 是该类套件的设计跑法**（`api-host-supervisors-fallback.test.ts`
  文件头注释即声明 "Test pattern mirrors uploads-http.test.ts: bind the real
  Bun.serve server on an ephemeral port with a temp DB"）。逐文件结果：
  rfc030-principal-rest 3/0、rfc030-reply-lifecycle-e2e 1/0、
  api-host-supervisors-fallback 8/0。

## 原始输出摘录（完整日志由 bun test 重跑即可再生）

```
error: Unable to connect. Is the computer able to access the url?
(fail) REST /api/task — production entry principal stamp > real HTTP + real utok: ... [1.02ms]
error: Unable to connect. Is the computer able to access the url?
(fail) REST /api/task — production entry principal stamp > unauthenticated REST dispatch ... [0.46ms]
error: Unable to connect. Is the computer able to access the url?
(fail) REST /api/broadcast — production entry principal stamp > broadcast rows stamped ... [0.49ms]
(fail) #380 — ... path 1 ... [5002.30ms]   ^ this test timed out after 5000ms.
(fail) #380 — ... path 2 ... [5002.31ms]
(其余 6 个 #380 path 同为 5000ms 超时，无任何 expect diff)
 1 pass
 11 fail
Ran 12 tests across 3 files.
```

## 给 §8 独立评审的复核建议

1. 逐文件跑三个套件 → 应全绿。
2. 合跑 → 检查每个 fail 的错误行：应全部为连接类（Unable to connect / timeout），
   无任何 `expect(received)` 断言 diff。
3. 在 baseline `d418862` 重复步骤 2（两 importer 版本）→ #380 8 fail 同类。
