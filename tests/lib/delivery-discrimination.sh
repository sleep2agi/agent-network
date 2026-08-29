# 投递语义判别力断言(#1459 类级护栏) —— 「两种相反情形必须给出不同读数」。
#
# 🔴 它防的形状:**把「我交出去了」当成「它到达了」**。
#    2026-08-29 一周内三处互不相干的代码同时踩到:
#      #1276  内存映射未命中时 `|| "hub"` —— 编造了一个收件人,而不是说「不知道」
#      #1277  tasks 行以字面量 'delivered' 无条件插入,而推送另有条件
#      #1459  只写 audit_log + 扇出即返回 ok:true;无订阅者时事件直接丢弃
#    不同的包、不同的作者、不同的功能 —— **不是一个 bug 被抄了三遍**。
#
# 为什么这一族特别难发现(照抄 SDK马 在 #1459 的归纳,因为它就是判据本身):
#   · 失败态与成功态**在返回值上同值** —— 按状态/计数的视角全都看不见
#   · 常见路径下碰巧是对的
#   · 修一处不会让另两处变红(它们没有共享代码)
#
# ⇒ 所以判据不能是「成功时返回成功」(那恒真),必须是:
#      **喂进相反的输入,读数必须不同。**
#
# 用法:
#     source tests/lib/delivery-discrimination.sh
#     delivery_discrimination_report() { bad "$@"; }     # 可选:接到套件计数
#     assert_discriminates <名字> <成功读数> <失败读数>
#
#   两个读数由调用方各自跑出来(本 helper 不替你造场景 —— 造场景的方式各套件
#   差别太大,硬塞一个通用的反而会逼人写假场景)。

if ! declare -F delivery_discrimination_report >/dev/null 2>&1; then
  delivery_discrimination_report() { printf 'FAIL %s\n' "$*"; }
fi

# assert_discriminates <name> <success_reading> <failure_reading>
#   两个读数相同  ⇒ 判别力为零,报告并返回 1
#   任一为空      ⇒ 同样拒绝(空 vs 空会假装"不同"或"相同",都不可信)
assert_discriminates() {
  local name="$1" ok_read="$2" bad_read="$3"
  if [ -z "$ok_read" ] || [ -z "$bad_read" ]; then
    delivery_discrimination_report \
      "delivery-discrimination $name 读数缺失(成功='$ok_read' 失败='$bad_read') —— 空读数不能证明判别力"
    return 1
  fi
  if [ "$ok_read" = "$bad_read" ]; then
    delivery_discrimination_report \
      "delivery-discrimination $name 判别力为零:成功与失败给出同一读数 '$ok_read' —— 这个字段没有验证投递事实"
    return 1
  fi
  return 0
}
