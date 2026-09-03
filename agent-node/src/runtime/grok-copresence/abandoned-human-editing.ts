// #880 —— human_editing 没有超时出口:人在 attach 的 TUI 里敲了字、没提交也没取消就走开,
// 仲裁永远停在 human_editing,网络任务只排队不注入,每条 300 s 后超时失败。
//
// 出口只在三条同时成立时才走,而且只做「人本来就能做的那一下」(Ctrl-C 取消编辑):
//   1. phase 是 human_editing;
//   2. 从最后一次人类按键算起已经 ≥ idleMs(默认 10 分钟)—— 人真在打字不会安静这么久;
//   3. 队列里有网络任务在等 —— 没人等就不打扰人的草稿(哪怕它已经放了一小时)。
// 代价是那半截草稿被清掉;日志写明「安静了多久、几条任务在等」,让人知道为什么。
export interface AbandonedHumanEditingInput {
  readonly phase: string;
  readonly sinceLastHumanInputMs: number;
  readonly queued: number;
  readonly idleMs?: number;
}

export const HUMAN_EDITING_IDLE_MS = 10 * 60_000;

export function describeAbandonedHumanEditing(input: AbandonedHumanEditingInput): string | null {
  if (input.phase !== "human_editing") return null;
  if (input.queued <= 0) return null;
  const idleMs = input.idleMs ?? HUMAN_EDITING_IDLE_MS;
  if (!Number.isFinite(input.sinceLastHumanInputMs) || input.sinceLastHumanInputMs < idleMs) return null;
  return `human composer has had no keystrokes for ${Math.round(input.sinceLastHumanInputMs / 60_000)}m while `
    + `${input.queued} network task(s) wait behind it — cancelling the abandoned draft (Ctrl-C) so they can run (#880). `
    + `Type again to take the TUI back.`;
}
