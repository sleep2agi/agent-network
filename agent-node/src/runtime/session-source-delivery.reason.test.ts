// 2026-11-10：交接守卫的异常被 deliver() 吞掉后，worker 只返回 unknown ——
// 客户端显示「结果未知」，运维看不到是哪个守卫拒的。这里钉「原因映射」这一层；
// 接线（异常真的走到映射）由 CI 同款镜像的实跑输出作证，不在单测里伪造 payload
// （伪造过两次都死在入口守卫上：/tmp 残留、isSourceNodeDelivery 拒收）。
import { sourceDeliveryFailureReason } from './session-source-delivery';

let failed = 0;
const check = (n: string, ok: boolean) => { if (!ok) { console.error('FAIL: ' + n); failed++; } else console.log('PASS: ' + n); };

check('具名守卫错误原样保留', sourceDeliveryFailureReason(new Error('source_resume_claim_handoff_refused')) === 'source_resume_claim_handoff_refused');
check('非 Error 的字符串也能取到', sourceDeliveryFailureReason('boom') === 'no reason captured');
check('超长原因被截断（日志不被单条刷爆）', sourceDeliveryFailureReason(new Error('x'.repeat(500))).length === 200);
check('null/undefined 不抛且给占位', sourceDeliveryFailureReason(null) === 'no reason captured' && sourceDeliveryFailureReason(undefined) === 'no reason captured');
check('message 非字符串时给占位', sourceDeliveryFailureReason({ message: 42 }) === 'no reason captured');

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all green');
