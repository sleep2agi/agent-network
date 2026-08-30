# `anet node resume <alias>` — Codex TUI 共存节点安全恢复 · 设计稿 v7

**Pinned to**: `origin/main = ceb2b5ff`
**Status**: **DESIGN v7** — TMHR final Phase 6 = **D**（NACK v6/A-C, 06cfb29a + 6b2049b4）。v5 Step 3 + env identity + v6 exit-9 + grep-lint + test770 承重全保留。

**Deltas v6→v7**：
1. **Phase 6 = D**：异节点 ACK 必跑，无 self-loop 兜底，无 --no-probe opt-out（TMHR 明确 override 我 v5/v6 的 A/C）
2. Config schema 加 `codexProbePeer`（第三个必需字段，Q7 迁移指引更新）
3. 探针发送机制：**必须目标节点经其 Bridge 实发**，CLI 不代发（禁 CLI 持目标 token）

**注**：v7 Phase 6 = D 是 TMHR 需求方最终裁定；通信龙 v5 ACK 里选 A/C 的建议已被 TMHR D 覆盖。理由（TMHR）：self-loop 无法独立证明**接收侧**和**跨节点路由闭环** —— 只能证明"我能对 hub 说话"，不能证明"另一个节点能收到我说的话 + hub 路由到那个节点工作"。身份验收需要覆盖这两个维度。

---

## §Phase 6 v7 = D (verbatim from TMHR 06cfb29a)

```
Phase 6 身份验收 (必跑, 无 opt-out)

前置检查 (Phase 0 已列, v7 强化):
  [0.X] config.codexProbePeer 必需字段:
        - 必须是已在 hub 注册的 alias
        - 必须 online (通过 hub /api/nodes 或 list_host_supervisors 查)
        - **必须非目标自身**
        缺失 / 未注册 / offline / === alias → **fail-closed exit 2 codex_probe_peer_invalid**

  --probe-to <peer> CLI override:
        - 只允许覆盖为**另一个合格异节点**（同样必须已注册 + online + 非自身）
        - 不允许覆盖为 self-loop
        - 不允许覆盖为 offline / unregistered peer

Phase 6 执行 (Phase 4 全过后触发):
  [6.1] 探针发送方**必须是恢复后的目标节点**, 经其 Bridge 实发
        - CLI 通过 hub 的合法 API 触发目标节点执行 (e.g. 一个 side-thread task 
          "please_send_probe" 让目标 bridge 走内部 send_task)
        - **禁 CLI/operator 持目标 token 代发** —— 这样做等于让第三方冒充目标节点
        - 探针内容: ANET_CODEX_RESUME_PROBE_V1 alias=<target> nonce=<uuid-v4>
  
  [6.2] 目标节点 Bridge send_task(alias=peer, task="<probe payload>")
  
  [6.3] Hub 权威记录核对四项身份字段:
        - from_name === <target alias>
        - from_node_id === config.node_id
        - to_name === codexProbePeer (或 --probe-to override)
        - to_node_id === (peer 当前活 node_id from hub)
  
  [6.4] 异节点 peer 侧返回同 nonce ACK
        (peer 需能识别 ANET_CODEX_RESUME_PROBE_V1 payload 并回 ACK; 
         若 peer 无此能力 → codexProbePeer 选错了, fail-closed)
  
  [6.5] 退出码矩阵 (全部非零 = exit 9, 独立 code):
        - send_failed              → exit 9 codex_probe_send_failed
        - delivery_timeout          → exit 9 codex_probe_delivery_timeout
        - peer_ack_timeout          → exit 9 codex_probe_peer_ack_timeout
        - nonce_mismatch            → exit 9 codex_probe_nonce_mismatch
        - sender_identity_mismatch  → exit 9 codex_probe_sender_identity_mismatch
        - receiver_identity_mismatch → exit 9 codex_probe_receiver_identity_mismatch
        - verified                  → exit 0

  [6.6] self-loop 允许作为**额外诊断**（打 witness 但不参与 pass/fail 判定）
        - 用途: 若 Phase 6 主 D 失败, self-loop 结果帮判是"我方发不出" vs "对端收不到"
        - 主 D 不允许被 self-loop 替代

  [6.7] 输出必须区分:
        - "process recovery: passed"
        - "identity attestation: passed"
        - 只有**两者都 passed** 才整体 exit 0
```

## §Q7 更新 (v7 迁移指引变更)

老 codex-copresence node 缺字段现在是 **3 个** (不是 2 个):
```
{
  "codexProjectDir": "<absolute path>",
  "codexLaunchAdapter": "codex-standard" | "codex-custom-wrapper",
  "codexProbePeer": "<registered peer alias, online, not self>"  // v7 new
}
```

Fail-fast 消息 + --dry-run JSON patch bonus 同步更新，operator 一次补三字段。

**codexProbePeer 语义**：这个字段回答"我崩了之后，谁给我做身份验证" —— 是节点自己出厂配置的一部分。TMHR 侧 default 可以是 TMHR 团队自己维护的一个 verifier 节点（e.g. 一个专用 attest peer），或者一个日常协作对端。

## §其余 v6 全保留

- v5 Step 3 (App Server process tree writer fd, TUI 不核 fd)
- v5 env.ANET_NODE_ID 辅助非承重
- v6 exit-9 matrix
- v6 grep-witness = lint only, test770 = 唯一承重执行证据
- v3 ownership-based Phase 4.2
- v2 --force 删 / Phase 1 窄备份 / Phase 4.3 hub 双源
- Δ4 witness 五处
- CI gate scope 限 codex lane + claude 3 处白名单 selftest 必须过 + 反例 D 红→绿证明
- Q8 no --force-take-over

## §test770 更新（Phase 6 D 测试）

```
测试 E (D happy path): 
  fixture: 起完整 target + 一个真 peer 节点
  执行: anet node resume <target>  # 用 config.codexProbePeer
  断言:
    - assert exit_code == 0
    - assert grep '[Phase 6] probe SENT via target Bridge (peer=<p>)' output
    - assert grep '[Phase 6] Hub identity: from_name=<t> from_node_id=<i1> to_name=<p> to_node_id=<i2>' output
    - assert grep '[Phase 6] peer ACK: nonce match' output
    - assert grep 'process recovery: passed' output
    - assert grep 'identity attestation: passed' output

测试 F (peer offline 反例):
  fixture: config.codexProbePeer 指向一个 offline peer
  执行: anet node resume <target>
  断言:
    - assert exit_code == 2 codex_probe_peer_invalid  (Phase 0 就拦, 不到 Phase 6)
    - assert grep '[Phase 0] codexProbePeer offline, refusing' output
    - assert NOT grep 'process recovery' output  # 根本没进 Phase 3

测试 G (peer 收到但不 ACK 反例):
  fixture: peer 侧 mock 收到 probe 但不发 ACK
  执行: anet node resume <target>
  断言:
    - assert exit_code == 9 codex_probe_peer_ack_timeout
    - assert grep 'process recovery: passed' output  # process 恢复没问题
    - assert grep 'identity attestation: FAILED' output
    - assert NOT grep 'identity attestation: passed' output

测试 H (CLI 代发禁止反例) - TMHR 44661926 补充:
  静态 grep = 辅助 lint only (存在 ≠ 会执行同一条铁律, v6 grep-witness lint 同族)
  🔴 承重断言必须是**运行时证明**:
    - 探针发起时观测: 发起者 pid === target Bridge pid (或 Bridge 进程组内)
    - Hub 事件核对: from_name/from_node_id === target, ACK from 异节点 receiver
    - 不得以 "CLI 源码没出现 target_token 字样" 替代执行证据
```

## §决策状态

- **TMHR**: ✅ **ACK v7** (44661926 + 2bf3c04a) — 加实现要求: 测试 H 静态 grep = lint, 承重必须运行时观测探针发起者 pid + Hub 事件核对
- **通信龙**: ✅ **ACK v7 = D** (df6d26d9 + e113b532) — 初 v5 选 A/C 便利性理由，读了 TMHR 完整性理由后 explicit 让步："在身份验收这条轴上，完整性压便利性；self-loop 收发两端同一进程，只在自己身上闭合的回路证不了对外可达。他是需求方，不 override"。附三条硬要求已并入 v7：① Phase 0 拒绝须指路 ② --help + docs 明写≥2 节点前置 ③ 单节点缺口单开 issue（→ #1527）

## Doc drift note

本 RFC 是 v7 定稿的历史记录，随 #1528 全实现落地。**当前 PR (#1538)** 不带任何 CLI surface，只 stage 内部 shape helper + schema fields —— 任何"用户读到"的行为 (Phase 0 诊断、`--help` 前置条件段、resume 分支可达) 都在 #1528，本 RFC 不作为 #1538 的合并依据。
