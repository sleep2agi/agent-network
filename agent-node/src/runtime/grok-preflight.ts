/* grok ACP 预检失败时说什么。
 *
 * 2026-08-30 起因(真机):Mac mini 上用 daemon 建了一个 grok-build-acp 节点,
 * 它给用户回的是:
 *
 *     grok 错误: grok CLI not found. Install Grok Build CLI and run
 *     `grok --version` before starting this node.
 *
 * 而那台机器上 grok **装着**,就在官方安装器放它的地方(`~/.grok/bin/grok`,
 * 见 docs/grok-build-cli-preview.md:安装器自己打印 "installed to …/.grok/bin/grok")。
 * 真正的原因是 daemon 的 PATH 里没有 `~/.grok/bin`,而 **daemon 建出来的子节点
 * 继承 daemon 的 PATH**。照那句话去重装,装十遍也不会好。
 *
 * 🔴 这条不是新知识 —— grok-copresence/runtime.ts 里已经写着同一条实测:
 *    「grok 装在 ~/.grok/bin,而 PTY 的受控 env 里没有它」。那条路修好了,
 *    ACP 这条预检没跟上。
 *
 * 🔴 这里**不能**建议 `GROK_BINARY`:那个覆盖只有 grok-build-cli 那条路读
 *    (cli.ts 的 processWithGrokCli),grok-build-acp 从头到尾没读过它。
 *    建议一个在本运行时无效的开关,等于把这条报错的毛病换个方向再犯一次。
 */

/** execFile 抛出来的东西里,我们真正用得上的那几格。 */
export type GrokPreflightError = {
  readonly code?: string;
  readonly status?: number | null;
  readonly stderr?: string;
};

const HINT_INSTALL = "没装的话按 docs/grok-build-cli-preview.md 装";

/** 把预检失败翻译成一句**说得出下一步**的话。`pathEnv` 原样回显 —— 
 *  「PATH 里没有」这种话,不把 PATH 印出来等于没说。 */
export function grokPreflightMessage(e: GrokPreflightError, pathEnv: string): string {
  const path = pathEnv || "(空)";
  if (e.code === "ENOENT") {
    return [
      "grok CLI 不在 PATH 上 —— 这**不等于**没装。",
      "  grok 的官方安装位置是 ~/.grok/bin/grok,而它默认不在登录 PATH 里。",
      "  先看装没装:  ls -l ~/.grok/bin/grok",
      '  装了就加进去:  export PATH="$HOME/.grok/bin:$PATH"',
      "  🔴 这个节点若是 daemon 建的:子节点继承 **daemon 的** PATH,",
      "     在你自己的 shell 里 export 没用 —— 要改 daemon 的启动环境再重启 daemon。",
      `  ${HINT_INSTALL}。`,
      `  当前 PATH: ${path}`,
    ].join("\n");
  }
  if (e.code === "EACCES") {
    return [
      "grok CLI 找到了,但不可执行(EACCES)。",
      '  chmod +x "$(command -v grok)"',
      `  当前 PATH: ${path}`,
    ].join("\n");
  }
  const tail = (e.stderr || "").trim().slice(0, 200);
  return [
    `grok CLI 在,但 \`grok --version\` 没跑成功${typeof e.status === "number" ? `(exit ${e.status})` : ""}。`,
    "  这不是找不到,是它自己起不来 —— 先手动跑一次 `grok --version` 看它说什么。",
    ...(tail ? [`  它的 stderr: ${tail}`] : []),
  ].join("\n");
}
