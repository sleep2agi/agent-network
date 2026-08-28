import { describe, expect, test } from "bun:test";
import { selectOwnedSideThreadSession } from "./owned-session";

const fake = (threadId: string, owned: boolean) => {
  let closed = 0;
  let killed = 0;
  return {
    session: {
      threadId,
      proc: owned ? { kill: () => { killed += 1; return true; }, exitCode: null, killed: false } : null,
      client: { close: () => { closed += 1; }, isConnected: true },
      bridge: {},
      get isRunning() { return true; },
    } as any,
    counts: () => ({ closed, killed }),
  };
};

describe("BTW owned app-server selection", () => {
  test("reuses an already-owned ordinary session without spawning another", async () => {
    const shared = fake("thread-source", true);
    let opens = 0;
    const selected = await selectOwnedSideThreadSession(shared.session, async () => {
      opens += 1;
      return fake("thread-source", true).session;
    });
    expect(selected).toEqual({ session: shared.session, dedicated: false });
    expect(opens).toBe(0);
  });

  test("shared TUI bridge gets a dedicated owned executor on the exact source thread", async () => {
    const shared = fake("thread-source", false);
    const owned = fake("thread-source", true);
    const selected = await selectOwnedSideThreadSession(shared.session, async () => owned.session);
    expect(selected).toEqual({ session: owned.session, dedicated: true });
    expect(owned.counts()).toEqual({ closed: 0, killed: 0 });
  });

  test("fallback to another thread closes and kills the candidate fail-closed", async () => {
    const shared = fake("thread-source", false);
    const wrong = fake("thread-fallback", true);
    await expect(selectOwnedSideThreadSession(shared.session, async () => wrong.session)).rejects.toThrow("exact source thread");
    expect(wrong.counts()).toEqual({ closed: 1, killed: 1 });
  });

  test("a second shared client cannot masquerade as an owned executor", async () => {
    const shared = fake("thread-source", false);
    const notOwned = fake("thread-source", false);
    await expect(selectOwnedSideThreadSession(shared.session, async () => notOwned.session)).rejects.toThrow("exact source thread");
    expect(notOwned.counts()).toEqual({ closed: 1, killed: 0 });
  });
});
