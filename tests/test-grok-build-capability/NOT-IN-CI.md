# 为什么 test-grok-build-capability 不进 CI

<!-- 🔴 下面两行是**机器读的**。散文里写撤销条件没有用 —— 没有任何东西会重新
     评估一个存在于注释/正文里的条件（这句话是仓里 dashboardReleaseTag() 上方的原话）。
     check-test-suite-registration.py 缺这两行会判红，并把 Verified 的天数
     打进每次都会出现的汇总行。-->
Verified: 2026-08-19
Revisit-when: #1033 修好之后 —— 末尾加 `[ "$FAIL" -eq 0 ] || exit 1`，并把 run.sh:194 / :210 那两处 `exit 0` 换成同一条判据。在退出码能承载 $FAIL 之前，接它进 CI 没有任何意义。

**它打印 `FAIL:` 然后退出 0 —— 这个套件在任何输入下都不可能失败。** 见 #1033。

## 实测（2026-08-19，`origin/main` = `55e86d1c`，本地 Docker）

    docker run --rm --network none -e ARTIFACT_DIR=/tmp/art <img>
      WARN: grok install - installer failed with status 6
      FAIL: grok install - grok binary not found after installer
      SKIP: auth source - no GROK_CODE_XAI_API_KEY and no mounted ~/.grok/auth.json
      WARN: permission default - could not confirm --always-approve flag from help
      SKIP: headless auth smoke - requires env token or mounted auth cache
      SKIP: ACP stdio - requires env token or mounted auth cache
      SKIP: ACP resume - requires env token or mounted auth cache
      SKIP: temp repo file edit - requires env token or mounted auth cache
    rc=0

统计：`SKIP=5  WARN=2  FAIL=1  PASS=0`。**零条 PASS，而且带着一条 FAIL 退出 0。**

## 机制

`run.sh` 里：

    :15   FAIL=0
    :39   fail() { FAIL=$((FAIL + 1)) ...
    :158    fail "grok install" "grok binary not found after installer"

计数器有，`fail()` 也确实在累加。**但文件末尾没有任何一处读 `$FAIL`** ——
最后几行是一串 `warn` 分支。另外 `:194` / `:210` 各有一个 `exit 0`，
在缺凭据时直接从中间退出。

所以 `FAIL:` 那一行只是打给人看的字符串，不影响退出码。

## 为什么不接

按 `rc` 接成阻塞门 = 一道**永远绿**的门，而且它绿的时候正在打印 `FAIL:`。
这比「没接」更糟：没接留着的是一个已知欠账，接了留下的是一条**假的覆盖记录**。

## 本地怎么真跑

    docker run --rm -e GROK_CODE_XAI_API_KEY=... -e ARTIFACT_DIR=/tmp/art <img>
    # 或挂载 auth 缓存
    docker run --rm -v /path/to/grok:/host-grok:ro -e ARTIFACT_DIR=/tmp/art <img>

## 什么时候该撤销这份豁免

**#1033 修好之后**，也就是至少满足：

1. 末尾加 `[ "$FAIL" -eq 0 ] || exit 1`，并把 `:194` / `:210` 那两处 `exit 0`
   换成同一条判据；
2. 报告里带分母（`执行 N / 跳过 M / 共 K`）。

在退出码能承载 `$FAIL` 之前，把它接进 CI 没有任何意义。
