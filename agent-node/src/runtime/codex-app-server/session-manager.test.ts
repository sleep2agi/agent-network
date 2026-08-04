import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCodexSessionManager } from "./session-manager";

type FakeSession = { id: number; isRunning: boolean };

describe("createCodexSessionManager", () => {
  test("the production Codex inbox path is wired through the shared holder", () => {
    const cli = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");
    const body = cli.slice(
      cli.indexOf("async function processWithCodexAppServer("),
      cli.indexOf("async function processWithGrok("),
    );
    expect(body).toContain("codexAppServerSessionManager.getOrOpen(async () =>");
    expect(body).toContain("codexAppServerThink(session,");
  });

  test("concurrent Dashboard handlers share one complete open attempt", async () => {
    const manager = createCodexSessionManager<FakeSession>();
    let opens = 0;
    let attaches = 0;
    let resumes = 0;
    let bridgeConstructions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory = async () => {
      opens++;
      attaches++;
      await gate;
      resumes++;
      bridgeConstructions++;
      return { id: opens, isRunning: true };
    };

    const first = manager.getOrOpen(factory);
    const second = manager.getOrOpen(factory);
    await Promise.resolve();
    expect(opens).toBe(1);
    expect(attaches).toBe(1);
    expect(manager.pending()).not.toBeNull();
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.id).toBe(1);
    expect(resumes).toBe(1);
    expect(bridgeConstructions).toBe(1);
    expect(manager.current()).toBe(a);
  });

  test("a rejected open is cleared and the next row can retry", async () => {
    const manager = createCodexSessionManager<FakeSession>();
    let opens = 0;
    await expect(manager.getOrOpen(async () => {
      opens++;
      throw new Error("bootstrap failed");
    })).rejects.toThrow("bootstrap failed");

    const recovered = await manager.getOrOpen(async () => {
      opens++;
      return { id: opens, isRunning: true };
    });
    expect(opens).toBe(2);
    expect(recovered.id).toBe(2);
  });

  test("stopped and explicitly invalidated sessions are never reused", async () => {
    const manager = createCodexSessionManager<FakeSession>();
    let nextId = 0;
    const factory = async () => ({ id: ++nextId, isRunning: true });
    const first = await manager.getOrOpen(factory);
    first.isRunning = false;
    const second = await manager.getOrOpen(factory);
    expect(second.id).toBe(2);
    manager.invalidate(first);
    expect(manager.current()).toBe(second);
    manager.invalidate(second);
    expect(manager.current()).toBeNull();
  });

  test("a session that dies during bootstrap is not published", async () => {
    const manager = createCodexSessionManager<FakeSession>();
    await expect(manager.getOrOpen(async () => ({ id: 1, isRunning: false })))
      .rejects.toThrow("stopped while opening");
    expect(manager.current()).toBeNull();
  });
});
