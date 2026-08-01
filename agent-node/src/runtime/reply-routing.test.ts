import { describe, expect, test } from "bun:test";
import {
  buildCodexAppServerReplyTask,
  createReplyRouteCache,
  resolveReplyRoute,
} from "./reply-routing";

const sessions = (...aliases: string[]) => aliases.map((alias) => ({ alias }));

describe("codex-app-server reply routing", () => {
  test("dashboard/user sender that is not a session falls back to send_reply", async () => {
    const route = await resolveReplyRoute({
      target: "admin",
      taskId: "task-dashboard",
      replyViaSendTask: true,
      cache: createReplyRouteCache(),
      loadSessions: async () => sessions("codex-node", "peer-agent"),
    });
    expect(route).toBe("send_reply");
  });

  test("agent sender with a real session keeps send_task wake path", async () => {
    const route = await resolveReplyRoute({
      target: "peer-agent",
      taskId: "task-peer",
      replyViaSendTask: true,
      cache: createReplyRouteCache(),
      loadSessions: async () => sessions("codex-node", "peer-agent"),
    });
    expect(route).toBe("send_task");
  });

  test("missing task id does not create an unparented reply task", async () => {
    const route = await resolveReplyRoute({
      target: "peer-agent",
      replyViaSendTask: true,
      cache: createReplyRouteCache(),
      loadSessions: async () => sessions("peer-agent"),
    });
    expect(route).toBe("send_reply");
  });

  test("roster load failure fails closed to send_reply", async () => {
    const route = await resolveReplyRoute({
      target: "peer-agent",
      taskId: "task-peer",
      replyViaSendTask: true,
      cache: createReplyRouteCache(),
      loadSessions: async () => {
        throw new Error("hub unavailable");
      },
    });
    expect(route).toBe("send_reply");
  });

  test("short ttl cache avoids repeated roster fetches and refreshes after expiry", async () => {
    let now = 1000;
    let calls = 0;
    let currentSessions = sessions("peer-agent");
    const cache = createReplyRouteCache();
    const loadSessions = async () => {
      calls++;
      return currentSessions;
    };

    await expect(resolveReplyRoute({
      target: "peer-agent",
      taskId: "task-peer",
      replyViaSendTask: true,
      cache,
      cacheTtlMs: 3000,
      nowMs: () => now,
      loadSessions,
    })).resolves.toBe("send_task");
    expect(calls).toBe(1);

    currentSessions = sessions("other-agent");
    now = 2000;
    await expect(resolveReplyRoute({
      target: "peer-agent",
      taskId: "task-peer",
      replyViaSendTask: true,
      cache,
      cacheTtlMs: 3000,
      nowMs: () => now,
      loadSessions,
    })).resolves.toBe("send_task");
    expect(calls).toBe(1);

    now = 5001;
    await expect(resolveReplyRoute({
      target: "peer-agent",
      taskId: "task-peer",
      replyViaSendTask: true,
      cache,
      cacheTtlMs: 3000,
      nowMs: () => now,
      loadSessions,
    })).resolves.toBe("send_reply");
    expect(calls).toBe(2);
  });

  test("failed send_task replies keep the peer-visible failure marker and high priority", () => {
    expect(buildCodexAppServerReplyTask("boom", true)).toEqual({
      task: "⚠️ boom",
      priority: "high",
    });
    expect(buildCodexAppServerReplyTask("done", false)).toEqual({
      task: "done",
      priority: "normal",
    });
  });
});
