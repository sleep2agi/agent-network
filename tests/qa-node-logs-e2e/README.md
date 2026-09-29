# qa-node-logs-e2e — 节点运行日志(tail_node_logs)端到端

真 hub + 真 agent-node 同一个镜像,用桌面端同款 MCP `tools/call`:

1. 节点上报 `logs_capable`(`/api/status` 可见)。
2. 往节点**自己的**日期日志里种哨兵:节点 token 原文、`Authorization: Bearer …`、
   `OPENAI_API_KEY=…`、`api_key="…"`、只存在于节点进程 env 里的一个凭据值。
   `tail_node_logs` 取回的内容里**一个哨兵都不能有**,且普通文字还在、出现 `[REDACTED]`。
3. `level=error` 只回错误行;`grep` 拿被遮住的那段字符去搜 ⇒ 0 行(不能当探测神谕)。
4. 读后即删:第二次读只剩 `content_purged`,hub 库里 `result_content` 为 NULL。
5. 节点 token 调 `tail_node_logs` 被拒;另一个网络的用户被拒;两者都不落请求行。
6. witnessed-red:把节点脱敏器改成原样放行后重启节点,第 2 步的断言必然失败(哨兵出现)。

跑法(仓库根):

```bash
docker build --build-arg QA_NODE_LOGS_SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-node-logs-e2e -f tests/qa-node-logs-e2e/Dockerfile .
docker run --rm anet-qa-node-logs-e2e
```

CI:`.github/workflows/qa.yml` 的 `qa-node-logs-e2e` job。
