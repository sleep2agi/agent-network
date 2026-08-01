import { describe, expect, it } from "bun:test";
import {
  newGrokCopresenceState,
  reduceGrokCopresenceState,
  restoreGrokCopresenceState,
  snapshotGrokCopresenceState,
  type GrokCopresenceEvent,
  type GrokCopresenceNetworkTask,
  type GrokCopresenceState,
  type GrokCopresenceTransition,
} from "./state";

function task(taskId: string): GrokCopresenceNetworkTask {
  return {
    taskId,
    from: `agent-${taskId}`,
    message: `message-${taskId}`,
    metadata: { order: taskId },
  };
}

function harness(initial = newGrokCopresenceState()) {
  let state: GrokCopresenceState = initial;
  return {
    get state() {
      return state;
    },
    send(event: GrokCopresenceEvent): GrokCopresenceTransition {
      const transition = reduceGrokCopresenceState(state, event);
      state = transition.state;
      return transition;
    },
  };
}

describe("Grok co-presence arbitration", () => {
  it("lets the first human byte win a simultaneous human/network race", () => {
    const h = harness();

    h.send({ type: "network_task_received", task: task("n1") });
    const claim = h.send({ type: "human_input_started" });
    expect(claim.accepted).toBe(true);
    expect(h.state.phase).toBe("human_editing");
    expect(h.state.queue.map(({ taskId }) => taskId)).toEqual(["n1"]);

    const attemptedStart = h.send({ type: "schedule_network" });
    expect(attemptedStart).toMatchObject({ accepted: false, effects: [] });
    expect(h.state.phase).toBe("human_editing");

    h.send({ type: "human_input_submitted" });
    expect(h.state).toMatchObject({ phase: "human_turn", activeTurn: { owner: "human" } });
    h.send({ type: "network_task_received", task: task("n2") });
    expect(h.state.queue.map(({ taskId }) => taskId)).toEqual(["n1", "n2"]);

    const wrongOwner = h.send({ type: "turn_completed", owner: "network" });
    expect(wrongOwner).toMatchObject({ accepted: false, effects: [] });
    expect(h.state.phase).toBe("human_turn");

    const humanDone = h.send({ type: "turn_completed", owner: "human" });
    expect(humanDone.effects).toEqual([{ type: "human_turn_completed" }]);
    expect(h.state.phase).toBe("idle");

    const networkStart = h.send({ type: "schedule_network" });
    expect(networkStart.effects).toEqual([{ type: "inject_network_task", task: task("n1") }]);
    expect(h.state.phase).toBe("network_turn");
  });

  it("gives a newly active human composer priority over an existing FIFO", () => {
    const h = harness();
    h.send({ type: "network_task_received", task: task("n1") });
    h.send({ type: "network_task_received", task: task("n2") });

    h.send({ type: "human_input_started" });
    h.send({ type: "network_task_received", task: task("n3") });
    expect(h.state.phase).toBe("human_editing");
    expect(h.state.queue.map(({ taskId }) => taskId)).toEqual(["n1", "n2", "n3"]);

    h.send({ type: "human_input_cancelled" });
    expect(h.state.phase).toBe("idle");
    expect(h.send({ type: "schedule_network" }).effects[0]).toMatchObject({
      type: "inject_network_task",
      task: { taskId: "n1" },
    });
  });

  it("dequeues network tasks FIFO and never preempts an active turn", () => {
    const h = harness();
    for (const id of ["n1", "n2", "n3"]) {
      h.send({ type: "network_task_received", task: task(id) });
    }

    expect(h.send({ type: "schedule_network" }).effects[0]).toMatchObject({
      type: "inject_network_task",
      task: { taskId: "n1" },
    });
    h.send({ type: "network_task_received", task: task("n4") });
    expect(h.state.queue.map(({ taskId }) => taskId)).toEqual(["n2", "n3", "n4"]);

    expect(h.send({ type: "schedule_network" })).toMatchObject({ accepted: false, effects: [] });
    expect(h.send({ type: "human_input_started" })).toMatchObject({ accepted: false, effects: [] });
    expect(h.state.activeTurn).toMatchObject({ owner: "network", task: { taskId: "n1" } });

    const completed: string[] = [];
    for (const expected of ["n1", "n2", "n3", "n4"]) {
      const done = h.send({ type: "turn_completed", owner: "network" });
      expect(done.effects[0]).toMatchObject({
        type: "network_turn_completed",
        task: { taskId: expected },
      });
      completed.push(expected);
      if (expected !== "n4") h.send({ type: "schedule_network" });
    }
    expect(completed).toEqual(["n1", "n2", "n3", "n4"]);
    expect(h.state).toMatchObject({ phase: "idle", queue: [], activeTurn: null });
  });

  it("cancels only queued timeouts and rejects duplicate task ids", () => {
    const h = harness();
    h.send({ type: "network_task_received", task: task("active") });
    h.send({ type: "network_task_received", task: task("timed-out") });
    h.send({ type: "schedule_network" });

    expect(h.send({ type: "network_task_cancelled", taskId: "timed-out" }).accepted).toBe(true);
    expect(h.state.queue).toEqual([]);
    expect(h.send({ type: "network_task_cancelled", taskId: "active" }).accepted).toBe(false);
    expect(h.state.activeTurn).toMatchObject({ owner: "network", task: { taskId: "active" } });
    expect(() => h.send({ type: "network_task_received", task: task("active") }))
      .toThrow("duplicate network task active");
  });

  it("retains the active network task and FIFO across disconnect/reconnect", () => {
    const h = harness();
    h.send({ type: "network_task_received", task: task("active") });
    h.send({ type: "network_task_received", task: task("queued") });
    h.send({ type: "schedule_network" });
    h.send({ type: "approval_requested" });

    h.send({ type: "disconnected" });
    expect(h.state).toMatchObject({
      phase: "recovering",
      recoveryFrom: "network_turn",
      activeTurn: { owner: "network", task: { taskId: "active" } },
      waitingHuman: true,
    });
    h.send({ type: "network_task_received", task: task("during-recovery") });
    expect(h.state.queue.map(({ taskId }) => taskId)).toEqual(["queued", "during-recovery"]);
    expect(h.send({ type: "schedule_network" })).toMatchObject({ accepted: false, effects: [] });

    const serialized = JSON.stringify(snapshotGrokCopresenceState(h.state));
    const restored = restoreGrokCopresenceState(JSON.parse(serialized));
    expect(snapshotGrokCopresenceState(restored)).toEqual(JSON.parse(serialized));

    const resumed = harness(restored);
    resumed.send({ type: "reconnected" });
    expect(resumed.state).toMatchObject({
      phase: "network_turn",
      recoveryFrom: null,
      activeTurn: { owner: "network", task: { taskId: "active" } },
    });
    resumed.send({ type: "approval_resolved_by_human" });
    expect(resumed.send({ type: "turn_completed", owner: "network" }).effects[0]).toMatchObject({
      type: "network_turn_completed",
      task: { taskId: "active" },
    });
    expect(resumed.send({ type: "schedule_network" }).effects[0]).toMatchObject({
      type: "inject_network_task",
      task: { taskId: "queued" },
    });
  });

  it("marks approvals waiting for the human without emitting a response", () => {
    const h = harness();
    h.send({ type: "human_input_started" });
    h.send({ type: "human_input_submitted" });

    const approval = h.send({ type: "approval_requested" });
    expect(approval.accepted).toBe(true);
    expect(approval.effects).toEqual([]);
    expect(h.state).toMatchObject({
      phase: "human_turn",
      activeTurn: { owner: "human" },
      waitingHuman: true,
    });

    const duplicate = h.send({ type: "approval_requested" });
    expect(duplicate).toMatchObject({ accepted: false, effects: [] });
    const resolved = h.send({ type: "approval_resolved_by_human" });
    expect(resolved.effects).toEqual([]);
    expect(h.state.waitingHuman).toBe(false);

    const done = h.send({ type: "turn_completed", owner: "human" });
    expect(done.effects).toEqual([{ type: "human_turn_completed" }]);
    expect(done.effects.some(({ type }) => type === "network_turn_completed")).toBe(false);
  });

  it("clears only an already-waiting preview todo resolution without completing the turn", () => {
    const h = harness();
    h.send({ type: "network_task_received", task: task("todo") });
    h.send({ type: "schedule_network" });

    expect(h.send({ type: "preview_todo_resolved_automatically" }).accepted).toBe(false);
    h.send({ type: "approval_requested" });
    const resolved = h.send({ type: "preview_todo_resolved_automatically" });
    expect(resolved).toMatchObject({ accepted: true, effects: [] });
    expect(h.state).toMatchObject({
      phase: "network_turn",
      activeTurn: { owner: "network", task: { taskId: "todo" } },
      waitingHuman: false,
    });

    const human = harness();
    human.send({ type: "human_input_started" });
    human.send({ type: "human_input_submitted" });
    human.send({ type: "approval_requested" });
    expect(human.send({ type: "preview_todo_resolved_automatically" }).accepted).toBe(false);
    expect(human.state).toMatchObject({
      phase: "human_turn",
      activeTurn: { owner: "human" },
      waitingHuman: true,
    });
  });
});
