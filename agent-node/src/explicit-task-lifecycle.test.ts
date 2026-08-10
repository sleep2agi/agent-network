import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { waitForExplicitTaskLifecycle, type ExplicitTaskLifecycleEmission } from "./explicit-task-trace";

function harness(statuses: Array<Record<string, unknown>>, options: {
  startedAt?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stale30Ms?: number;
  stale60Ms?: number;
} = {}) {
  let now = options.startedAt ?? 0;
  let index = 0;
  const emissions: ExplicitTaskLifecycleEmission[] = [];
  return {
    emissions,
    run: () => waitForExplicitTaskLifecycle("task_child", options.startedAt ?? 0, {
      getTask: async () => statuses[Math.min(index++, statuses.length - 1)],
      emit: (status, taskId, extra) => emissions.push({ status, taskId, extra }),
      now: () => now,
      sleep: async (ms) => { now += ms; },
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      stale30Ms: options.stale30Ms,
      stale60Ms: options.stale60Ms,
    }),
  };
}

describe("explicit delegation lifecycle trace", () => {
  it("keeps the production delegation loop wired through the tested state machine", () => {
    const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    expect(cli.match(/await waitForExplicitTaskLifecycle\(/g)?.length).toBe(1);
    expect(cli).toContain([
      "const lifecycle = await waitForExplicitTaskLifecycle(childTaskId, traceContext.startedAt, {",
      "    getTask: async (id) => parseToolJson(await callCommHub(\"get_task\", { task_id: id })),",
      "    emit: emitTrace,",
      "  });",
    ].join("\n"));
  });

  it("emits ack, start, and reply from the production polling state machine", async () => {
    const h = harness([
      { task: { status: "delivered" } },
      { task: { status: "acked" } },
      { task: { status: "running" } },
      { task: { status: "replied", result: "done" } },
    ]);
    const outcome = await h.run();
    expect(outcome.kind).toBe("terminal");
    expect(outcome.status).toBe("replied");
    expect(h.emissions.map((entry) => entry.status)).toEqual(["acked", "started", "replied"]);
  });

  it("emits both bounded stale warnings and expiry when delivery never advances", async () => {
    const h = harness([{ task: { status: "delivered" } }], {
      timeoutMs: 30,
      pollIntervalMs: 10,
      stale30Ms: 10,
      stale60Ms: 20,
    });
    const outcome = await h.run();
    expect(outcome.kind).toBe("expired");
    expect(h.emissions.map((entry) => entry.extra?.event ?? entry.status)).toEqual([
      "task.warning.delivered_stale_30s",
      "task.warning.delivered_stale_60s",
      "expired",
    ]);
    expect(h.emissions.at(-1)?.extra?.errorCode).toBe("lifecycle_timeout");
  });

  it("maps failed and cancelled terminal states to a failed trace without retrying", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const h = harness([{ status }]);
      const outcome = await h.run();
      expect(outcome.kind).toBe("terminal");
      expect(outcome.status).toBe(status);
      expect(h.emissions).toEqual([{
        status: "failed",
        taskId: "task_child",
        extra: { errorCode: `task_${status}`, event: "task.failed" },
      }]);
    }
  });
});
