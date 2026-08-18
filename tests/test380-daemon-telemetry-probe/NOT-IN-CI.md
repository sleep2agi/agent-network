# test380-daemon-telemetry-probe 不进 CI

Verified: 2026-08-19
Revisit-when: 有人给它加了「判据」——即某个观测为坏时 `exit 1`，而不只是写进报告。

## 为什么

**它是诊断探针，不是门。** 它的发现全部通过 `raw` 写进 `$REPORT`，
**退出码不认这些发现**；只有 setup 失败（hub /health、register、network、mint token）
才 `exit 1`。所以把它当阻塞门接进 CI 的话，**它无论探到什么都是绿的**。

原文（`tests/test380-daemon-telemetry-probe/run.sh:258-263`）：

    if [[ "$SNAPSHOT_SET" == "NO" ]]; then
      raw ""
      raw "  ▶ nodes.config_snapshot is unset even after 8s wait."
      raw "    Immediate reportStatus() at cli.ts:4095 either failed silently or hasn't fired yet."
      raw "    This directly explains list_host_supervisors returning 0 → create-node wizard 'hub 400'."
    fi

`raw` 之后没有 `exit`。这一段是**条件文案**，不是观测结果 ——
2026-08-19 在 `e413a297` 上实跑，走的是另一个分支：

    nodes.config_snapshot = YES
      "role": "host_supervisor",
    ▶ heartbeat reached hub and cpu/mem are present → register()'s host: payload lands.

（顺带：文案里的 `cli.ts:4095` 已经漂了，今天那段在 `agent-node/src/cli.ts:6054-6061`。）

它作为**排障工具**是有价值的，值班时手动跑一次能一次性拿到
/proc、心跳、host 遥测列、config_snapshot 四层读数。但那是工具，不是门。
