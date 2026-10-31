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

THREAT_MODELS = ("accident", "adversary")
# 2026-10-31 —— 外部复核 (c)：「断言须写成 (命题, 定义域, 观测点, 可信度)，并加 verified_on」。
# 这一格回答的是「这个读数在哪里成立的」：本机直跑 ≠ CI 跑过 ≠ 线上跑过。
# 少了它，「本仓 0 命中」会被当成「线上安全」——而那是两件事。
VERIFIED_ON = ("local", "ci", "production", "unknown")


def print_scope(*, covers: str, does_not_cover: str, threat_model: str, reading_rule: str,
                verified_on: str = "local") -> None:
    if threat_model not in THREAT_MODELS:
        raise SystemExit(f"内部错误：threat_model 必须是 {THREAT_MODELS} 之一，收到 {threat_model!r}")
    if verified_on not in VERIFIED_ON:
        raise SystemExit(f"内部错误：verified_on 必须是 {VERIFIED_ON} 之一，收到 {verified_on!r}")
    for name, value in (("covers", covers), ("does_not_cover", does_not_cover),
                        ("threat_model", threat_model), ("reading_rule", reading_rule)):
        if not value or not str(value).strip():
            raise SystemExit(f"内部错误：SCOPE 的 {name} 不能为空（空着等于没有边界）")
    print("SCOPE")
    print(f"  covers         : {covers}")
    print(f"  does_not_cover : {does_not_cover}")
    print(f"  threat_model   : {threat_model}")
    print(f"  reading_rule   : {reading_rule}")
    print(f"  verified_on    : {verified_on}（这个读数在哪里成立；local ≠ CI ≠ 线上）")


def selftest() -> int:
    """四个字段缺一个都必须炸 —— 否则「有 SCOPE 块」会退化成「有个块」。"""
    fails = 0
    cases = [
        ("空 covers", dict(covers="", does_not_cover="x", threat_model="accident", reading_rule="x")),
        ("空 does_not_cover", dict(covers="x", does_not_cover="  ", threat_model="accident", reading_rule="x")),
        ("非法 threat_model", dict(covers="x", does_not_cover="x", threat_model="maybe", reading_rule="x")),
        ("空 reading_rule", dict(covers="x", does_not_cover="x", threat_model="adversary", reading_rule="")),
        ("非法 verified_on", dict(covers="x", does_not_cover="x", threat_model="accident", reading_rule="x", verified_on="somewhere")),
    ]
    for label, kwargs in cases:
        try:
            print_scope(**kwargs)
        except SystemExit:
            print(f"  ✓ selftest {label} ⇒ 拒绝输出")
        else:
            fails += 1
            print(f"  ✗ selftest {label} ⇒ 居然输出了")
    if fails == 0:
        print("  ✓ selftest 5/5：五个字段缺任何一个/取值不在闭集都不会输出")
    return 0 if fails == 0 else 1
