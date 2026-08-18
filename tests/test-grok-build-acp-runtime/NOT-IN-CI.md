# 为什么 test-grok-build-acp-runtime 不进 CI

<!-- 🔴 下面两行是**机器读的**。散文里写撤销条件没有用 —— 没有任何东西会重新
     评估一个存在于注释/正文里的条件（这句话是仓里 dashboardReleaseTag() 上方的原话）。
     check-test-suite-registration.py 缺这两行会判红，并把 Verified 的天数
     打进每次都会出现的汇总行。-->
Verified: 2026-08-19
Revisit-when: 满足任一 —— (a) 套件在缺凭据时以**非 0**退出；(b) 报告里带分母（执行 N / 跳过 M / 共 K），让「一条都没跑」在输出里可见；(c) CI 上有了安全提供 Grok 凭据的通道。

**它在没有凭据时 `rc=0`，但一条断言都不执行。**

## 实测（2026-08-19，`origin/main` = `55e86d1c`，本地 Docker）

    docker run --rm --network none -e ARTIFACT_DIR=/tmp/art <img>
      # Grok Build ACP runtime E2E
      SKIP: no GROK_CODE_XAI_API_KEY and no /host-grok/auth.json
    rc=0

统计：`SKIP=1  PASS=0  FAIL=0`。**整个套件就是一次 skip。**

## 为什么不接（这个理由和 test231 / test232 不一样）

test231 / test232 同样缺凭据，但它们**红**：

    test231:  FAIL: real binary is not pinned Grok 0.2.93        rc=1
    test232:  cp: cannot stat '/host-grok/auth.json'              rc=1

**红是可读的信号** —— 门红了，人会去看为什么。
而这个套件是 `rc=0` 且零条断言：接成阻塞门会得到一道**永远绿、什么都没断言**的门。

**那比不接更糟。** 不接，至少还留着「它没被跑过」这个已知欠账；
接了，就变成一条「已覆盖」的假记录 —— 而假记录和真覆盖在 CI 面板上长得一样。

## 本地怎么真跑

    # 二选一：给环境变量，或挂载 auth 缓存
    docker run --rm -e GROK_CODE_XAI_API_KEY=... -e ARTIFACT_DIR=/tmp/art <img>
    docker run --rm -v /path/to/grok:/host-grok:ro -e ARTIFACT_DIR=/tmp/art <img>

## 什么时候该撤销这份豁免

任一条成立即可：

1. 套件改成**缺凭据时以非 0 退出**（那样它就变成和 test231/test232 同一类，
   可以按「有理由的豁免」重新评估，或接进一条带凭据的专用 lane）；
2. 报告里加上**分母**（`执行 N / 跳过 M / 共 K`），让「一条都没跑」在输出里可见；
3. CI 上有了安全提供 Grok 凭据的通道。

见 #1033（同族问题：`test-grok-build-capability` 的 `FAIL` 计数器是只写的）。
