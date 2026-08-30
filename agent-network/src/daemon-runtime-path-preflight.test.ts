/* 2026-08-30 —— 真机上这条链断在最不该断的地方:
 * daemon 建的 grok 节点报「grok CLI not found」,而 grok 装在 ~/.grok/bin。
 * 子节点继承 daemon 的 PATH,而 daemon 的 PATH 里没有它。
 */
import { describe, expect, test } from "bun:test";
import {
  daemonPathWarnings, RUNTIME_BINARY_HINTS,
} from "./daemon-runtime-path-preflight.js";

const GROK_RUNTIMES = ["grok-build-acp", "grok-build-cli", "grok-copresence"];
const never = () => false;
const always = () => true;

describe("🔴 daemon 启动预检:装了但看不见,才值一条警告", () => {
  /* 真机那一例。 */
  test("🔴 声称支持 grok + 不在 PATH + 装在 ~/.grok/bin ⇒ 警告", () => {
    const w = daemonPathWarnings({
      runtimes: ["claude-agent-sdk", "grok-build-acp"],
      resolvesOnPath: never,
      existsInHomeDir: always,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("grok-build-acp");
    expect(w[0]).toContain(".grok/bin");
    expect(w[0]).toContain("继承 daemon 的 PATH");
    expect(w[0]).toContain('export PATH="$HOME/.grok/bin:$PATH"');
  });

  /* 🔴 这三条是「不该响的时候别响」。一条会乱响的警告,一周内就会被无视 —— 
   * 那等于把它删掉,而且是悄悄删掉。 */
  test("在 PATH 上 ⇒ 不警告", () => {
    expect(daemonPathWarnings({
      runtimes: GROK_RUNTIMES, resolvesOnPath: always, existsInHomeDir: always,
    })).toEqual([]);
  });

  test("🔴 压根没装 ⇒ 不警告(交给节点启动时那句报错,它才知道细节)", () => {
    expect(daemonPathWarnings({
      runtimes: GROK_RUNTIMES, resolvesOnPath: never, existsInHomeDir: never,
    })).toEqual([]);
  });

  test("🔴 没声称支持 grok ⇒ 不警告(daemon init 默认声称全部 runtime,乱响会刷屏)", () => {
    expect(daemonPathWarnings({
      runtimes: ["claude-agent-sdk", "codex-sdk"],
      resolvesOnPath: never, existsInHomeDir: always,
    })).toEqual([]);
  });

  /* 三个 grok runtime 任意一个被声称都该触发,而且只出一条(别刷三遍)。 */
  test("三个 grok runtime 各自都能触发,且合并成一条", () => {
    for (const r of GROK_RUNTIMES) {
      const w = daemonPathWarnings({
        runtimes: [r], resolvesOnPath: never, existsInHomeDir: always,
      });
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(r);
    }
    const all = daemonPathWarnings({
      runtimes: GROK_RUNTIMES, resolvesOnPath: never, existsInHomeDir: always,
    });
    expect(all).toHaveLength(1);
  });

  /* 🔴 这张表是"凭印象加一行"最容易出事的地方 —— 加进来的每一条都必须有出处。 */
  test("🔴 表里每一条都带 evidence,且 runtimes 非空", () => {
    expect(RUNTIME_BINARY_HINTS.length).toBeGreaterThanOrEqual(1);
    for (const h of RUNTIME_BINARY_HINTS) {
      expect(h.evidence.length).toBeGreaterThan(10);
      expect(h.runtimes.length).toBeGreaterThan(0);
      expect(h.binary.length).toBeGreaterThan(0);
      expect(h.homeRelativeDir.startsWith("/")).toBe(false);  // 相对 $HOME,别写绝对路径
    }
  });

  /* 🔴 分母自证:上面那些「不警告」的用例,必须是在一个**确实会警告**的
   * 配置上做减法得到的,否则它们可能只是因为函数恒返回空。 */
  test("🔴 分母自证:同一组输入只改一个条件就会响", () => {
    const base = { runtimes: GROK_RUNTIMES, resolvesOnPath: never, existsInHomeDir: always };
    expect(daemonPathWarnings(base)).toHaveLength(1);          // 会响
    expect(daemonPathWarnings({ ...base, resolvesOnPath: always })).toEqual([]);   // 只改这个 → 不响
  });
});
