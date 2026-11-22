// 「CLI 在等一个选项」的可观测信号（#cli-prompt-options ①）。
//
// 范围：**只做可观测**。不改任何 runtime 的 TUI 行为 —— 这里只是把「看到了一句像提示的文本」
// 变成一个结构化信号，交给 Hub 投影，让 App 能显示「该节点在等哪类选项」。
//
// 为什么先做可观测：Agent 侧现在只看到「不回话」，Hub 侧没有任何信号，
// 运维/用户无法区分「跑得慢」「卡住了」「在等人选」。
//
// 保守原则：
//   · 只匹配**已知固定短语**，不确定的一律不报（宁可漏报，不可误报 —— 误报会让人去点不存在的选项）
//   · excerpt 会做脱敏与截断（≤200 字符，去控制字符、去 token 形状）
//   · 纯函数 + 注入时间，便于单测

export type PromptKind =
  | "codex_update"
  | "codex_trust"
  | "claude_trust"
  | "opencode_update"
  | "login_required"
  | "unknown";

export interface InteractivePromptSignal {
  kind: PromptKind;
  excerpt: string;
  detected_at: string;
}

const PATTERNS: ReadonlyArray<{ kind: PromptKind; re: RegExp }> = [
  // 顺序有意义：更具体的在前
  { kind: "codex_trust", re: /Do you trust the (files|contents) in this (folder|directory)\?/i },
  { kind: "claude_trust", re: /Do you want to (trust|continue)[^\n]{0,40}(folder|directory|files)/i },
  { kind: "codex_update", re: /(Update available|A new version of Codex is available)/i },
  { kind: "opencode_update", re: /(update available for opencode|opencode [0-9.]+ is available)/i },
  { kind: "login_required", re: /(Please (log ?in|sign ?in)|Run:? ?(claude|codex|opencode|agy) login|no supported non-interactive auth method)/i },
];

/** 把一行输出里的「可能是在等选项」抽成信号；不像提示返回 null。 */
export function detectInteractivePrompt(
  line: string,
  now: number = Date.now(),
): InteractivePromptSignal | null {
  if (typeof line !== "string" || !line) return null;
  // 只在前 4000 字符里找：超长输出（例如 dump 正文）不当作提示
  const text = line.slice(0, 4000).replace(/\u001b\[[0-9;]*m/g, "");
  for (const { kind, re } of PATTERNS) {
    if (!re.test(text)) continue;
    return { kind, excerpt: redactExcerpt(text), detected_at: new Date(now).toISOString() };
  }
  return null;
}

/** excerpt：去控制字符、折叠空白、去掉像 token 的串，截断到 200。 */
export function redactExcerpt(line: string): string {
  let s = line.replace(/[\u0000-\u001f\u007f]/g, " ");
  s = s.replace(/\b(ntok_|utok_|sk-|ghp_)[A-Za-z0-9_\-]{8,}/g, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/** 同一类提示重复出现时不要刷屏：保留首次时间、更新摘录。 */
export function mergePromptSignal(
  previous: InteractivePromptSignal | null | undefined,
  next: InteractivePromptSignal,
): InteractivePromptSignal {
  if (previous && previous.kind === next.kind) return { ...next, detected_at: previous.detected_at };
  return next;
}
