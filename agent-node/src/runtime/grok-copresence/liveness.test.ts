import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  describeGrokCopresenceLiveness,
  isNamedGrokCopresenceSocket,
  resolveGrokCopresenceHubStatus,
  type GrokCopresenceLivenessSource,
} from "./liveness";

const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function listenUnix(path: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return server;
}

describe("Grok copresence liveness and hub status", () => {
  test("a missing session is never idle or working", () => {
    const liveness = describeGrokCopresenceLiveness(null, true);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(liveness, "working")).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(liveness, "offline")).toBe("offline");
    expect(resolveGrokCopresenceHubStatus(liveness, "error")).toBe("error");
  });

  test("named attach.sock and leader.sock plus a live composer are the only idle path", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-liveness-"));
    cleanup.push(root);
    const attachSocket = join(root, "attach.sock");
    const leaderSocket = join(root, "leader.sock");
    const relaySocket = join(root, "relay.sock");
    await listenUnix(attachSocket);
    await listenUnix(leaderSocket);
    await listenUnix(relaySocket);

    const live: GrokCopresenceLivenessSource = {
      isRunning: true,
      tuiReady: true,
      attachSocket,
      leaderSocket,
    };
    expect(isNamedGrokCopresenceSocket(attachSocket, "attach")).toBe(true);
    expect(isNamedGrokCopresenceSocket(leaderSocket, "leader")).toBe(true);
    expect(resolveGrokCopresenceHubStatus(describeGrokCopresenceLiveness(live, true), "idle")).toBe("idle");
    expect(resolveGrokCopresenceHubStatus(describeGrokCopresenceLiveness(live, true), "working")).toBe("working");

    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, tuiReady: false }, true),
      "idle",
    )).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, isRunning: false }, true),
      "idle",
    )).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, attachSocket: relaySocket }, true),
      "idle",
    )).toBe("blocked");

    const short: GrokCopresenceLivenessSource = {
      isRunning: true,
      tuiReady: true,
      attachSocket: join(root, "a.sock"),
      leaderSocket: join(root, "l.sock"),
    };
    expect(isNamedGrokCopresenceSocket(short.attachSocket, "attach")).toBe(true);
    expect(isNamedGrokCopresenceSocket(short.leaderSocket, "leader")).toBe(true);
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness(short, true, () => true),
      "idle",
    )).toBe("idle");
  });

  test("a leftover non-socket file at the attach path is not present", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-liveness-file-"));
    cleanup.push(root);
    const attachSocket = join(root, "attach.sock");
    const leaderSocket = join(root, "leader.sock");
    await Bun.write(attachSocket, "not-a-socket");
    await listenUnix(leaderSocket);
    const liveness = describeGrokCopresenceLiveness({
      isRunning: true,
      tuiReady: true,
      attachSocket,
      leaderSocket,
    });
    expect(liveness.attach.present).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });
});

/* #1548 —— leaderless build 上的 `usable`。
 *
 * 病灶:有些 grok build **按设计不建 leader.sock**(`runtime.ts` 能力表里
 * `autoLeader: false`,例如 1.0.5);`settleLeader()` 对这类 build 把 **ENOENT 当成功**。
 * 而本函数此前**无条件**要求 `leaderPresent` ⇒ 这类节点上 `usable` 结构性恒假
 * ⇒ 心跳的 `idle` 每 3 分钟被改写成 `blocked`,永远。
 * 现场:名册 3 个 blocked 全是这类节点,非 grok 节点 **0/114**。
 *
 * 🔴 三格验收,缺一不可(通信龙 定):
 *   1. leaderless + 运行时可用      → 不再 blocked
 *   2. leaderless + 运行时真不可用  → 仍然 blocked   ← 只做 1 会把真故障一起放过,
 *                                                      **而放过之后没有别的信号会报警**
 *   3. autoLeader:true + 缺 socket  → 仍然 blocked   ← 别把老 build 的保护一起拆了
 */
describe("#1548 leaderless build 的 usable", () => {
  const base = (root: string) => ({
    isRunning: true,
    tuiReady: true,
    attachSocket: join(root, "attach.sock"),
    leaderSocket: join(root, "leader.sock"),
  });

  test("① leaderless + 运行时可用(只有 attach.sock)→ 不再 blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-leaderless-ok-"));
    cleanup.push(root);
    await listenUnix(join(root, "attach.sock"));      // 只建 attach,不建 leader
    const liveness = describeGrokCopresenceLiveness(base(root), false);
    expect(liveness.leader.present).toBe(false);       // 事实照实报
    expect(liveness.usable).toBe(true);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("idle");
    expect(resolveGrokCopresenceHubStatus(liveness, "working")).toBe("working");
  });

  /* 🔴 第 2 格是整组的重点:只做第 1 格的话,一个"leaderless ⇒ 一律 usable"的实现
   * 也能全绿,而那会**把真故障一起放过去** —— 且放过之后没有任何别的信号会报警,
   * 因为这一格是唯一的。 */
  test("② leaderless + 子进程死了 → 仍然 blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-leaderless-dead-"));
    cleanup.push(root);
    await listenUnix(join(root, "attach.sock"));
    const liveness = describeGrokCopresenceLiveness({ ...base(root), isRunning: false }, false);
    expect(liveness.usable).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });

  test("② leaderless + TUI 没就绪 → 仍然 blocked", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-leaderless-notui-"));
    cleanup.push(root);
    await listenUnix(join(root, "attach.sock"));
    const liveness = describeGrokCopresenceLiveness({ ...base(root), tuiReady: false }, false);
    expect(liveness.usable).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });

  test("② leaderless + attach.sock 不在 → 仍然 blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-leaderless-noattach-"));
    cleanup.push(root);                                // 一个 socket 都不建
    const liveness = describeGrokCopresenceLiveness(base(root), false);
    expect(liveness.usable).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });

  test("🔴 ③ autoLeader:true + 缺 leader.sock → 仍然 blocked(老 build 的保护一格没松)", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-autoleader-missing-"));
    cleanup.push(root);
    await listenUnix(join(root, "attach.sock"));
    const liveness = describeGrokCopresenceLiveness(base(root), true);
    expect(liveness.usable).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });

  /* 🔴 反向 fail-closed:leaderless build 上 socket **不该出现**。它若出现,
   * 说明「这个 build 不外派工具」这个前提不成立 —— `settleLeader()` 在启动时
   * 就是这么处理的(「verified as leaderless yet created …」直接抛)。
   * 这里不比它松:出现了就不 usable。 */
  test("🔴 leaderless build 上 leader.sock 竟然出现 → 不 usable(与 settleLeader 同向)", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-leaderless-unexpected-"));
    cleanup.push(root);
    await listenUnix(join(root, "attach.sock"));
    await listenUnix(join(root, "leader.sock"));       // 不该有,却有
    const liveness = describeGrokCopresenceLiveness(base(root), false);
    expect(liveness.leader.present).toBe(true);
    expect(liveness.usable).toBe(false);
  });

  /* 分母自证:上面这组里 usable 两侧都有(1 真 / 5 假),
   * 否则"恒假"或"恒真"的实现都能挑一半用例过。 */
  test("分母自证:这组用例 usable 两侧都有", async () => {
    const ok = mkdtempSync(join(tmpdir(), "grok-denom-ok-"));
    cleanup.push(ok);
    await listenUnix(join(ok, "attach.sock"));
    expect(describeGrokCopresenceLiveness(base(ok), false).usable).toBe(true);
    expect(describeGrokCopresenceLiveness(base(ok), true).usable).toBe(false);
  });
});
