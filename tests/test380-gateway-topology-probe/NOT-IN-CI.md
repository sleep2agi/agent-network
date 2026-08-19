# test380-gateway-topology-probe 不进 CI

Verified: 2026-08-19
Revisit-when: 有人给它加了「判据」——即某个观测为坏时 `exit 1`，而不只是写进报告。

## 为什么

**它是诊断探针，不是门。** 和 `tests/test380-daemon-telemetry-probe/NOT-IN-CI.md`
是完全同一个形状：发现全部通过 `raw` 写进 `$REPORT`，**退出码不认这些发现**。

`tests/test380-gateway-topology-probe/daemon-run.sh` 共 356 行，
`exit 1` 只出现在 **setup 失败**处：

    :80   [[ "$UTOK" == utok_* ]]        || { rec "register" "FAILED: $ADMIN"; exit 1; }
    :84   [[ -n "$NET_ID" ]]             || { rec "network"  "FAILED: $NET";   exit 1; }
    :88   [[ "$DEMO_HOST_TOK" == ntok_* ]] || { rec "mint"   "FAILED";         exit 1; }

结尾没有任何基于观测的判定，只是把报告打出来：

    raw "  So 'hub 400' means the client omitted network_id — NOT that no daemons"
    raw "  exist. If prod dashboard reports hub 400 in the create-node wizard,"
    …
    echo "===== REPORT ====="
    cat "$REPORT"

⇒ **接成阻塞门的话，它无论探到什么都是绿的。**

它作为**排障工具**有价值：值班时手动跑一次，能一次性拿到 hub↔daemon 拓扑、
`list_host_supervisors` 的返回、以及 `hub 400` 到底是「客户端没带 network_id」
还是「真的没有 daemon」。但那是工具，不是门。

（这条目录此前**连被这道门看见的资格都没有** —— `suites()` 只认 `run.sh`，
而它的入口是 `docker-compose.yml` + `daemon-run.sh`。取集放宽后它会落进 exempt，
位置才对。见 issue #1064。）
