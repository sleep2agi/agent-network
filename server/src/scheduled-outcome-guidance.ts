/** Dispatch guidance is not a classifier. Only an authenticated, successful
 * producer's explicit reply may record an outcome; omissions stay unknown. */
export function scheduledOutcomeGuidance(taskId: string): string {
  return `\n\n[Agent Network / scheduled work outcome]\n` +
    `此计划已显式启用空转退避。完成本轮实际工作并核验范围后，正常 send_reply 回原任务时使用 in_reply_to="${taskId}"。保留工具要求的原收件人、认证身份及 thread/turn 绑定。\n` +
    `仅当本轮正常成功且确认有实质变更，添加 meta: {"scheduled_work_outcome":"changed"}；仅当正常成功且完成范围检查、确认没有实质变更，添加 meta: {"scheduled_work_outcome":"no_changes"}。\n` +
    `未核实、失败、超时、过期、跳过或仅在等待输入/权限时，不自报 no_changes；不要从回复措辞或没有工具调用推断结果。缺少支持该字段的正常回复工具时保留未知，由原回复链路收口。\n` +
    `此字段是本节点自报，不是独立完成证明。不要用 send_task/send_message 或额外消息补记结果，不要为了退避伪造成功或改动计划频率。`;
}
