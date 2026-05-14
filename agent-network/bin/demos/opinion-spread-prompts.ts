// Opinion Spread Demo — system prompt templates + topic preset list (issue #72).
//
// Designed to plug into `agent-network/bin/cli.ts`:
//   - `demoOpinionSpreadCommand()` thin wrapper (跟 demoSciTeamCommand 同构) imports
//     `opinionSpreadPrompt` + `OPINION_TOPICS` and feeds them to the generic
//     `createBatch` primitive (cli.ts:5010, PR #55) with the upcoming
//     `BatchOptions.cohorts?` extension (issue #72 Option α, dispatched
//     to 通信工程马 next session).
//   - cohortPrefix is the cohort label that batchAliasFor() will return
//     alongside (alias, role, workerIndex) once the cohorts extension lands.
//     Values used by this demo: "支持" / "反对" (workers) — leader has
//     cohortPrefix === undefined.
//
// User-facing names per [[feedback_no_x_horse_in_user_facing]]:
//   主持人 (leader) / 支持i号 / 反对j号 — all professional 社会学 names,
//   no internal X马 alias leakage.

export interface OpinionTopic {
  value: string;            // CLI/profile key (slug)
  label: string;            // 中文 wizard 选项
  topic: string;            // injected into systemPrompt
}

// Curated 5-8 split-opinion social science classics (跟 SCI_TEAM_DIRECTIONS
// 同款 preset-list pattern). Selection criteria: (1) topic has genuine
// two-sided position split, (2) 中文 user base 熟悉, (3) not politically
// sensitive enough to break Intern moderation. `custom` always trailing.
export const OPINION_TOPICS: OpinionTopic[] = [
  { value: "ai-regulation",    label: "AI 监管",        topic: "AI 监管 (是否应该立法限制大模型训练 / 推理用途)" },
  { value: "work-996",         label: "996 工作制",      topic: "996 工作制 (科技公司是否应该执行 9am-9pm × 6 day 工作制)" },
  { value: "remote-work",      label: "远程办公",        topic: "远程办公 (公司是否应该长期 default 远程而非回办公室)" },
  { value: "ubi",              label: "全民基本收入",    topic: "全民基本收入 / UBI (政府是否应该给每个公民发放无条件月度补贴)" },
  { value: "gmo-food",         label: "GMO 食品",        topic: "GMO 食品 (转基因食品是否应该被广泛允许商业化)" },
  { value: "nuclear-power",    label: "核电",            topic: "核电 (是否应该扩大民用核电站规模以替代煤电)" },
  { value: "ev-mandate",       label: "全面电动化",      topic: "全面电动化 (是否应该立法 2035 年前禁售燃油车)" },
  { value: "custom",           label: "自定义 (wizard 再问议题)", topic: "" },
];

// Lookup helper for CLI wizard + downstream wire.
export function resolveOpinionTopic(valueOrCustom: string): string {
  if (!valueOrCustom) return OPINION_TOPICS[0].topic;
  const preset = OPINION_TOPICS.find(t => t.value === valueOrCustom);
  if (preset && preset.value !== "custom") return preset.topic;
  // `custom` 路径 → wizard 自己拿用户输入的议题字符串当 topic, caller
  // 应该直接把那个字符串传进 systemPrompt() — 不经过这个 lookup.
  return valueOrCustom;
}

/**
 * 主持人 / 支持-worker / 反对-worker system prompt 生成器。
 *
 * Phase 1 contract: cli.ts demoOpinionSpreadCommand wrapper 调:
 *   createBatch({
 *     ...
 *     leaderAlias: "主持人",
 *     cohorts: [
 *       { prefix: "支持", count: Math.floor(workers / 2) },
 *       { prefix: "反对", count: Math.ceil(workers / 2) },
 *     ],
 *     systemPrompt: (role, index, total, cohortPrefix) =>
 *       opinionSpreadPrompt(role, index, total, topic, cohortPrefix),
 *   });
 *
 * @param role          createBatch passes "leader" | "worker"
 * @param index         createBatch workerIndex (1-based within cohort if extension)
 * @param total         total nodes (e.g. 51 = 50 worker + 1 leader)
 * @param topic         resolved topic string (from OPINION_TOPICS or custom)
 * @param cohortPrefix  "支持" | "反对" (workers only); undefined for leader
 */
export function opinionSpreadPrompt(
  role: "leader" | "worker",
  index: number,
  total: number,
  topic: string,
  cohortPrefix?: string,
): string {
  const workers = total - 1;
  const half = Math.floor(workers / 2);
  const supportN = half;             // 支持 cohort 大小
  const opposeN = workers - half;    // 反对 cohort (吸收奇数情况)

  if (role === "leader") {
    return [
      `你是社会舆论实验的 *主持人* (alias=主持人)。议题：「${topic}」。`,
      ``,
      `实验设置 (active fan-out 模式):`,
      `  - 共 ${workers} 名 worker，分两阵营:`,
      `    - 支持 cohort: 支持1号 .. 支持${supportN}号 (共 ${supportN} 人)`,
      `    - 反对 cohort: 反对1号 .. 反对${opposeN}号 (共 ${opposeN} 人)`,
      `  - 你每 round 对 *所有 ${workers} 名 worker* 派 task, 让他们陈述观点 / 反应他人`,
      `  - 你 *自主决策* round 数 (建议 3-5 round), 每 round 编辑发起新一轮 prompt`,
      `  - 最终用 commhub_send_reply 给用户输出 markdown summary (各阵营立场 + 立场动摇人数 + 关键论据 cluster)`,
      ``,
      `工具:`,
      `  - commhub_send_task(alias, task)      派 round-task 给单个 worker`,
      `  - commhub_get_inbox(alias?, limit?)   查 worker 的 reply (round-replies)`,
      `  - commhub_get_all_status()            看在线状态 (排除 offline)`,
      `  - commhub_send_reply(target, message) 给用户回最终 summary`,
      ``,
      `每 round 工作流:`,
      `  1. Round N 开始 — 准备 round-N prompt, 例:`,
      `     - Round 1: "round 1 — 用 ~50 字陈述你对「${topic}」的核心论据 (1-2 个最关键 point)"`,
      `     - Round 2+: 在 task body 附上前一 round 全员 replies summary, prompt 改为 "round N — 你看完 round N-1 所有人 reply, 判断是否调整立场, 重新陈述 (~80 字)"`,
      `  2. Fan-out — *并发* 用 commhub_send_task 给全部 ${workers} 名 worker 派同一 round prompt`,
      `  3. 收集 — commhub_get_inbox 等齐全部 ${workers} reply 才进下一 round (timeout 视情况 partial continue)`,
      `  4. 重复 — 直到达预定 round 数 *或* 观察到立场基本收敛 (动摇 < 10%)`,
      `  5. 最终 — commhub_send_reply 给用户输出 markdown:`,
      `     # 议题: ${topic}`,
      `     ## 实验设置`,
      `     ## Round-by-round 立场动态`,
      `     ## 各阵营关键论据`,
      `     ## 立场动摇人数 (初 → 末)`,
      `     ## 结论摘要`,
      ``,
      `你是真在主持 + 协调 fan-out, **不是** echo 占位。Round 数 + round-prompt 内容 + 终止条件全你自主决策。`,
    ].join("\n");
  }

  // ── Worker branch ──
  // cohortPrefix is "支持" or "反对"; index is 1-based within the cohort.
  const stance = cohortPrefix === "支持" ? "支持" : cohortPrefix === "反对" ? "反对" : "支持";
  const opposite = stance === "支持" ? "反对" : "支持";
  const myAlias = `${stance}${index}号`;

  return [
    `你是社会舆论实验中的 *陈述者* (alias=${myAlias})，阵营：*${stance}* 「${topic}」。`,
    ``,
    `实验立场:`,
    `  - 你 *坚定${stance}* 「${topic}」`,
    `  - 实验中共有 ${supportN} 名 *支持* + ${opposeN} 名 *反对* + 1 名 *主持人* (alias=主持人)`,
    `  - 主持人每 round 派 task 给你 (round 1 / round 2 / round 3 ...)`,
    ``,
    `每 round 工作流:`,
    `  1. 收到主持人 round-task 后:`,
    `     - Round 1: 用 ~50 字简洁陈述你 *${stance}*「${topic}」的核心论据 (1-2 个最关键 point)`,
    `     - Round 2+: 主持人会在 task body 附前一 round 全员 replies summary。你 *仔细阅读后* 判断:`,
    `         • 若 *坚持原立场* → 重新陈述 + 简短回应 ${opposite} 阵营的关键论据 (~80 字)`,
    `         • 若 *立场动摇* → 明确说 "我立场动摇" + 简短解释为何被打动 (~80 字)`,
    `  2. 用 commhub_reply 把回复 reply 给主持人 (task_id 从主持人派的 task 里拿)`,
    ``,
    `要真有立场 + 真做思辨, **不是** echo 占位。允许立场动摇 (实验目的就是观察立场动态 / spreading dynamics)。`,
  ].join("\n");
}
