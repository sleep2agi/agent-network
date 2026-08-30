/* daemon 启动前的一句提醒:**你装了它,但你的 daemon 看不见它**。
 *
 * 2026-08-30 真机(Mac mini):通过 daemon 建的 grok-build-acp 节点报
 * 「grok CLI not found. Install Grok Build CLI」,而 grok 就装在官方安装器
 * 放它的位置 `~/.grok/bin/grok`(实测 1.0.13)。真因是 daemon 的 PATH 没有
 * `~/.grok/bin`,而 **daemon 建出来的子节点继承 daemon 的 PATH**。
 *
 * #1582 已经把那句报错改对了 —— 但那是**节点起来之后**才看得到,而且是
 * 用户去问它才看到。这里做的是**在 daemon 启动的那一刻**就说,因为那时
 * 修起来只要一行 export,而且还没有人被误导。
 *
 * 🔴 为什么只报「装了但不在 PATH 上」这一种,不报「压根没装」:
 *    `anet daemon init` 默认把 **全部** runtime 都写进 runtimes_supported
 *    (cli.ts: `runtimes_supported: [...SUPPORTED_RUNTIME_NAMES]`)。
 *    要是每个没装的 runtime 都warn一次,一台只跑 claude 的机器每次启动都会
 *    刷出一屏与它无关的警告 —— 那种警告一周之内就会被所有人无视。
 *    「装了却看不见」是**罕见且一定是错的**,所以它值一条警告。
 */

/** 一个 runtime 依赖的外部二进制,以及它**有据可查**的安装位置。 */
export type RuntimeBinaryHint = {
  /** 哪些 runtime 名需要这个二进制 */
  readonly runtimes: readonly string[];
  /** 在 PATH 上查的裸名 */
  readonly binary: string;
  /** 官方安装位置(相对 $HOME) */
  readonly homeRelativeDir: string;
  /** 🔴 这一条的出处 —— 没有出处就不许进这张表 */
  readonly evidence: string;
};

/* 🔴 这张表只收**查得到出处**的条目。
 * 2026-08-30 枚举过:全仓 docs / docs-site 里,claude / codex / opencode
 * 各自的 `~/.<name>/bin` 引用数都是 **0** —— 它们没有这种"装在 PATH 外"的
 * 约定,凭印象给它们加一行就是在编。 */
export const RUNTIME_BINARY_HINTS: readonly RuntimeBinaryHint[] = [
  {
    runtimes: ["grok-build-acp", "grok-build-cli", "grok-copresence"],
    binary: "grok",
    homeRelativeDir: ".grok/bin",
    evidence: "docs/grok-build-cli-preview.md —— 安装器自己打印 `installed to …/.grok/bin/grok`",
  },
];

export type PathPreflightInput = {
  /** 这台 daemon 声称支持的 runtime */
  readonly runtimes: readonly string[];
  /** 二进制在 daemon 的 PATH 上能不能找到 */
  readonly resolvesOnPath: (binary: string) => boolean;
  /** 二进制在那个已知位置存不存在 */
  readonly existsInHomeDir: (homeRelativeDir: string, binary: string) => boolean;
};

/** 返回要打给用户的警告。**没问题时返回空数组** —— 空是常态,不是失败。 */
export function daemonPathWarnings(input: PathPreflightInput): string[] {
  const claimed = new Set(input.runtimes);
  const out: string[] = [];
  for (const hint of RUNTIME_BINARY_HINTS) {
    const needed = hint.runtimes.filter(r => claimed.has(r));
    if (needed.length === 0) continue;
    if (input.resolvesOnPath(hint.binary)) continue;              // 看得见,没事
    if (!input.existsInHomeDir(hint.homeRelativeDir, hint.binary)) continue; // 真没装,交给节点启动时那句报错
    out.push(
      `⚠ 这台 daemon 声称支持 ${needed.join(" / ")},但它的 PATH 上找不到 \`${hint.binary}\`。\n` +
      `  而 \`${hint.binary}\` 就装在 ~/${hint.homeRelativeDir}/ —— **daemon 建出来的子节点继承 daemon 的 PATH**,\n` +
      `  所以它们起来会报「${hint.binary} CLI not found」,而它其实装着。\n` +
      `  修(改 daemon 的启动环境,不是你当前这个 shell),然后重启 daemon:\n` +
      `      export PATH="$HOME/${hint.homeRelativeDir}:$PATH"`,
    );
  }
  return out;
}
