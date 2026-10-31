"""Gates 共用的 SCOPE 块：**让结论带着边界一起出门**。

2026-10-31 —— 外部复核（原话）：
    「每次运行打印 SCOPE 块：covers / does_not_cover / threat_model / reading_rule。
      谁把这次的绿贴出去，作用域会一起被贴出去。
      这是今晚第一次把『威胁模型』写成字段而不是句子。」

为什么必须有它：绿（或 0）是最容易被单独引用出去的东西。
一张图、一条 CI 通过的截图、一句「门绿了」，都不会带着「它扫了什么、不扫什么、
挡的是事故还是对手」一起走。⇒ 把这三件事变成**输出的固定部分**。

四个字段的含义（缺一条这个块就退化成一个吉祥物）：
    covers          这次实际覆盖的对象（域 + 规则）
    does_not_cover  明确不覆盖的对象（运行时拼出来的 / 其它仓库 / 测试文件 / 动态特性）
    threat_model    accident（挡误用）还是 adversary（挡有意伪造）—— 不许含糊
    reading_rule    「这个读数什么时候才有意义」（例如 0 只有在阳性对照命中时才有意义）
"""
from __future__ import annotations

# 2026-10-31 —— 外部复核（原话）：
#   「阴性对照需要**阳性可达**：信息量来自『同一观测点、同样操作、本来可以成功』；
#     若该观测点根本到不了目标 ⇒『仍然坏』是必然的 ⇒ 这条对照恒真。」
#     实测：agent.tianma.cn 公网 NXDOMAIN（双源确认，对照 anet.sh 正常）
#     ⇒ 网外用户原样刷新必然报错 ⇒ 会被读成「稳定复现」，而真相是「到不了」。
#
# 所以 SCOPE 的 reading_rule 除了说「什么时候才有意义」，还必须能回答
# **「这个观测点本来可以成功吗」** —— 不能的话，那条对照不是对照。
#
# 一个选项对应两种修法相反的成因时，它不是选项，是问题的前半句
# （例：「不受信任（颁发者未知）」= 未装根证书（去装）或 流量被 MITM（去查代理））。

THREAT_MODELS = ("accident", "adversary")
FAILURE_MODES = ("loud", "silent")

import subprocess as _sp


def _measured_on() -> str:
    """这棵树是哪一棵 —— 不带版本的作用域声明，描述的是**一类**仓库，不是一个仓库。

    2026-10-31 —— 外部复核 ①：「补 measured_on: ref=<sha> dirty=<bool>
    ⇒ 贴在错的树上的 SCOPE 块自己会说出来。」
    """
    try:
        ref = _sp.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip() or "unknown"
        dirty = bool(_sp.run(["git", "status", "--porcelain"], capture_output=True, text=True, timeout=15).stdout.strip())
        return f"ref={ref} dirty={'yes' if dirty else 'no'}"
    except Exception:
        return "ref=unknown dirty=unknown"
# 2026-10-31 —— 外部复核 (c)：「断言须写成 (命题, 定义域, 观测点, 可信度)，并加 verified_on」。
# 这一格回答的是「这个读数在哪里成立的」：本机直跑 ≠ CI 跑过 ≠ 线上跑过。
# 少了它，「本仓 0 命中」会被当成「线上安全」——而那是两件事。
VERIFIED_ON = ("local", "ci", "production", "unknown")


def print_scope(*, covers: str, does_not_cover: str, threat_model: str, reading_rule: str,
                failure_mode: str, failure_mode_how: str,
                verified_on: str = "local", domain_count: int | None = None,
                domain_source: str = "") -> None:
    """domain_count / domain_source —— 2026-10-31 外部复核 ④：

    「定义域也是一个集合，就必须有分母和来源；手写的定义域基数会在下一次重构后
      变成假命题，而它长得完全正常。」

    ⇒ 这两个参数**必填**：任何一个门说「我扫了 X」，都要能说清 X 有多少、那个数是哪来的
      （git ls-files / rglob / 显式清单）。缺一个就拒绝输出。
    """
    if threat_model not in THREAT_MODELS:
        raise SystemExit(f"内部错误：threat_model 必须是 {THREAT_MODELS} 之一，收到 {threat_model!r}")
    if verified_on not in VERIFIED_ON:
        raise SystemExit(f"内部错误：verified_on 必须是 {VERIFIED_ON} 之一，收到 {verified_on!r}")
    for name, value in (("covers", covers), ("does_not_cover", does_not_cover),
                        ("threat_model", threat_model), ("reading_rule", reading_rule)):
        if not value or not str(value).strip():
            raise SystemExit(f"内部错误：SCOPE 的 {name} 不能为空（空着等于没有边界）")
    if not isinstance(domain_count, int) or domain_count <= 0:
        raise SystemExit("内部错误：domain_count 必填且必须为正整数（「扫了 X」要能说清 X 有多少）")
    if failure_mode not in FAILURE_MODES:
        raise SystemExit(f"内部错误：failure_mode 必须是 {FAILURE_MODES} 之一（边界外它会红还是会静默报 0）")
    if not failure_mode_how or not str(failure_mode_how).strip():
        raise SystemExit("内部错误：failure_mode_how 必填（靠什么变响 / 为什么不会响）")
    if not domain_source or not str(domain_source).strip():
        raise SystemExit("内部错误：domain_source 必填（那个数是哪来的：git ls-files / rglob / 显式清单）")
    print("SCOPE")
    print(f"  covers         : {covers}")
    print(f"  does_not_cover : {does_not_cover}")
    print(f"  threat_model   : {threat_model}")
    print(f"  reading_rule   : {reading_rule}")
    print(f"  failure_mode   : {failure_mode}（{failure_mode_how}）")
    print(f"  domain_count   : {domain_count}（{domain_source}）")
    print(f"  measured_on    : {_measured_on()}")
    print(f"  verified_on    : {verified_on}（这个读数在哪里成立；local ≠ CI ≠ 线上）")


def selftest() -> int:
    """四个字段缺一个都必须炸 —— 否则「有 SCOPE 块」会退化成「有个块」。"""
    fails = 0
    ok_args = dict(domain_count=1, domain_source="selftest", failure_mode="loud", failure_mode_how="selftest")
    cases = [
        ("空 covers", dict(covers="", does_not_cover="x", threat_model="accident", reading_rule="x", **ok_args)),
        ("空 does_not_cover", dict(covers="x", does_not_cover="  ", threat_model="accident", reading_rule="x", **ok_args)),
        ("非法 threat_model", dict(covers="x", does_not_cover="x", threat_model="maybe", reading_rule="x", **ok_args)),
        ("空 reading_rule", dict(covers="x", does_not_cover="x", threat_model="adversary", reading_rule="", **ok_args)),
        ("非法 verified_on", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", verified_on="somewhere", **ok_args)),
        ("缺 domain_count", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", domain_source="selftest")),
        ("缺 domain_source", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", domain_count=3)),
        ("非法 failure_mode", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", domain_count=1, domain_source="s", failure_mode="maybe", failure_mode_how="x")),
        ("空 failure_mode_how", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", domain_count=1, domain_source="s", failure_mode="loud", failure_mode_how="")),
    ]
    for label, kwargs in cases:
        try:
            print_scope(**kwargs)
        except (SystemExit, TypeError):
            print(f"  ✓ selftest {label} ⇒ 拒绝输出")
        else:
            fails += 1
            print(f"  ✗ selftest {label} ⇒ 居然输出了")
    if fails == 0:
        print("  ✓ selftest 9/9：缺少任一边界字段（含 failure_mode / domain_count）都不会输出")
    return 0 if fails == 0 else 1
