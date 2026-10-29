#!/usr/bin/env python3
"""#1510 补：`npm publish` 退出码 1 不等于「没发出去」。

现场（2026-10-29，`0.9.0-preview.203`）：

    npm error code TLOG_CREATE_ENTRY_ERROR
    npm error error creating tlog entry - (409) an equivalent entry already exists
               in the transparency log
    ##[error]Process completed with exit code 1.

而 registry 上版本**已经存在**（`preview` dist-tag 已指向 .203）。

后果比错误本身严重：publish 步骤 exit 1 ⇒ 后面的「发后核实（轮询 registry 最多 45 分钟）」
**从来没跑**。于是「已发布」和「发布失败」在 CI 上都长成同一个样子：红。
人看到红的第一反应是重跑，重跑又撞同一个 409 —— 陷进一个与事实完全相反的循环。

这个脚本**不判发布成败**，只判一件事：这次失败是不是「透明度日志已记录」这一类。

    exit 0  是这类 → 不该由 publish 步骤判死，交给后面的「发后核实」判
    exit 1  不是   → 交回调用方按真失败处理（退出码照原样返回）

为什么不自己查 registry：这个 workflow 后面已经有一步「发后核实」，
它会轮询 registry 最多 45 分钟并比对 tag 与 shasum（`.github/scripts/verify-npm-publish-visible.sh`）。
那是唯一有资格说「发出去了 / 没发出去」的地方。
在这里自己再查一次、等 5 分钟，只是**同一件事判两遍，且判得比后面那步更粗**。
"""
from __future__ import annotations

import sys

# npm 的透明度日志冲突：条目的语义是「已经记过了」，不是「被拒绝」。
# 三种写法都见过：错误码、409 + 短语、以及只给短语的旧版输出。
_TLOG_MARKERS = (
    "TLOG_CREATE_ENTRY_ERROR",
    "equivalent entry already exists",
    "an equivalent entry already exists in the transparency log",
)


def is_tlog_duplicate(log_text: str) -> bool:
    """日志是否表示「透明度日志里已有等价条目」。

    只看标记，不做任何猜测：没有标记就是普通失败（鉴权、2FA、网络、空间不足……）。
    """
    return any(marker in log_text for marker in _TLOG_MARKERS)


def decide(log_text: str) -> tuple[int, str]:
    """纯判据：把日志映射成「是否属于本类」与一句话结论。

    写成纯函数是为了能在 --selftest 里逐条断言 —— 这条判据出错的方式很隐蔽：
    它会把「已发布」标成红，然后有人去重发、撞 409、再重发；
    反过来，把真失败标成绿更糟，所以非冲突标记一律不许放行。
    """
    if is_tlog_duplicate(log_text):
        return 0, "透明度日志报「等价条目已存在」—— 这是「已记过」不是「被拒绝」，交由发后核实判定"
    return 1, "不是透明度日志冲突 → 按真失败处理"


def selftest() -> int:
    failures: list[str] = []

    def check(name: str, got, want) -> None:
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    real_log = """
npm notice Publishing to https://registry.npmjs.org/ with tag preview and public access
npm error code TLOG_CREATE_ENTRY_ERROR
npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID 108e9186
##[error]Process completed with exit code 1.
"""
    auth_log = """
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@scope%2fpkg - You do not have permission
##[error]Process completed with exit code 1.
"""
    # 1. 真实日志 ⇒ 不判死，交给发后核实（这正是 2026-10-29 那次）
    check("tlog → 0", decide(real_log)[0], 0)
    # 2. 鉴权失败 ⇒ 真失败，绝不能被放成绿
    check("403 → 1", decide(auth_log)[0], 1)
    # 3. 空日志（进程被 kill 等）⇒ 真失败
    check("空日志 → 1", decide("")[0], 1)
    # 4. 只给短语的旧版输出也要认出来
    check("只有短语 → 0", decide("an equivalent entry already exists")[0], 0)
    # 5. 标记识别不能把普通错误算进来
    check("is_tlog real", is_tlog_duplicate(real_log), True)
    check("is_tlog auth", is_tlog_duplicate(auth_log), False)

    for f in failures:
        print(f"FAIL: {f}")
    print("publish-outcome selftest: %s (%d 条判据)" % ("FAILED" if failures else "OK", 7))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    args = argv[1:]
    opts: dict[str, str] = {}
    i = 0
    while i < len(args):
        if args[i].startswith("--") and i + 1 < len(args):
            opts[args[i][2:]] = args[i + 1]
            i += 2
        else:
            i += 1
    log_path = opts.get("log")
    if not log_path:
        print("usage: publish-outcome.py --log FILE | --selftest", file=sys.stderr)
        return 64
    try:
        with open(log_path, encoding="utf-8", errors="replace") as fh:
            log_text = fh.read()
    except OSError as e:
        print(f"读不到日志 {log_path}: {e}", file=sys.stderr)
        return 1
    code, message = decide(log_text)
    stream = sys.stdout if code == 0 else sys.stderr
    print(("::notice::" if code == 0 else "::error::") + message, file=stream)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
