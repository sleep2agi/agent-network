// Pure input-arbitration state for the Grok co-presence runtime.
//
// Network arrivals are deliberately enqueue-only. The PTY owner must issue a
// separate `schedule_network` event after it has drained pending human input.
// This gives the first human keystroke an atomic claim on the composer and
// prevents a queued network turn from racing ahead of a human.

export type GrokCopresencePhase =
  | "idle"
  | "human_editing"
  | "human_turn"
  | "network_turn"
  | "recovering";

export type GrokCopresenceTurnOwner = "human" | "network";

export type GrokCopresenceJson =
  | null
  | boolean
  | number
  | string
  | GrokCopresenceJson[]
  | { [key: string]: GrokCopresenceJson };

export interface GrokCopresenceNetworkTask {
  taskId: string;
  from: string;
  message: string;
  metadata?: { [key: string]: GrokCopresenceJson };
}

export type GrokCopresenceActiveTurn =
  | { owner: "human" }
  | { owner: "network"; task: GrokCopresenceNetworkTask };

type RecoverablePhase = Exclude<GrokCopresencePhase, "recovering">;

export interface GrokCopresenceState {
  phase: GrokCopresencePhase;
  queue: GrokCopresenceNetworkTask[];
  activeTurn: GrokCopresenceActiveTurn | null;
  recoveryFrom: RecoverablePhase | null;
  waitingHuman: boolean;
  revision: number;
}

export interface GrokCopresenceSnapshot extends GrokCopresenceState {
  version: 1;
}

export type GrokCopresenceEvent =
  | { type: "network_task_received"; task: GrokCopresenceNetworkTask }
  | { type: "network_task_cancelled"; taskId: string }
  | { type: "human_input_started" }
  | { type: "human_input_submitted" }
  | { type: "human_input_cancelled" }
  | { type: "schedule_network" }
  | { type: "turn_completed"; owner: GrokCopresenceTurnOwner }
  | { type: "disconnected" }
  | { type: "reconnected" }
  | { type: "approval_requested" }
  | { type: "approval_resolved_by_human" }
  | { type: "preview_todo_resolved_automatically" };

export type GrokCopresenceEffect =
  | { type: "inject_network_task"; task: GrokCopresenceNetworkTask }
  | { type: "network_turn_completed"; task: GrokCopresenceNetworkTask }
  | { type: "human_turn_completed" };

export interface GrokCopresenceTransition {
  state: GrokCopresenceState;
  accepted: boolean;
  effects: GrokCopresenceEffect[];
}

export function newGrokCopresenceState(): GrokCopresenceState {
  return {
    phase: "idle",
    queue: [],
    activeTurn: null,
    recoveryFrom: null,
    waitingHuman: false,
    revision: 0,
  };
}

export function reduceGrokCopresenceState(
  state: GrokCopresenceState,
  event: GrokCopresenceEvent,
): GrokCopresenceTransition {
  assertGrokCopresenceState(state);

  switch (event.type) {
    case "network_task_received": {
      const task = copyTask(event.task);
      assertTask(task);
      if (
        state.queue.some((queued) => queued.taskId === task.taskId)
        || (state.activeTurn?.owner === "network" && state.activeTurn.task.taskId === task.taskId)
      ) {
        throw new Error(`duplicate network task ${task.taskId}`);
      }
      return changed(state, {
        queue: [...state.queue.map(copyTask), task],
      });
    }

    case "network_task_cancelled": {
      const index = state.queue.findIndex((task) => task.taskId === event.taskId);
      if (index < 0) return ignored(state);
      return changed(state, {
        queue: state.queue.filter((_, taskIndex) => taskIndex !== index).map(copyTask),
      });
    }

    case "human_input_started":
      if (state.phase !== "idle") return ignored(state);
      return changed(state, { phase: "human_editing" });

    case "human_input_submitted":
      if (state.phase !== "human_editing") return ignored(state);
      return changed(state, {
        phase: "human_turn",
        activeTurn: { owner: "human" },
        waitingHuman: false,
      });

    case "human_input_cancelled":
      if (state.phase !== "human_editing") return ignored(state);
      return changed(state, { phase: "idle" });

    case "schedule_network": {
      if (state.phase !== "idle" || state.queue.length === 0) return ignored(state);
      const [next, ...remaining] = state.queue;
      const task = copyTask(next);
      return changed(
        state,
        {
          phase: "network_turn",
          queue: remaining.map(copyTask),
          activeTurn: { owner: "network", task },
          waitingHuman: false,
        },
        [{ type: "inject_network_task", task: copyTask(task) }],
      );
    }

    case "turn_completed": {
      if (event.owner === "human") {
        if (state.phase !== "human_turn" || state.activeTurn?.owner !== "human") {
          return ignored(state);
        }
        return changed(
          state,
          { phase: "idle", activeTurn: null, waitingHuman: false },
          [{ type: "human_turn_completed" }],
        );
      }

      if (state.phase !== "network_turn" || state.activeTurn?.owner !== "network") {
        return ignored(state);
      }
      const task = copyTask(state.activeTurn.task);
      return changed(
        state,
        { phase: "idle", activeTurn: null, waitingHuman: false },
        [{ type: "network_turn_completed", task }],
      );
    }

    case "disconnected":
      if (state.phase === "recovering") return ignored(state);
      return changed(state, {
        phase: "recovering",
        recoveryFrom: state.phase,
      });

    case "reconnected":
      if (state.phase !== "recovering" || state.recoveryFrom === null) return ignored(state);
      return changed(state, {
        phase: state.recoveryFrom,
        recoveryFrom: null,
      });

    case "approval_requested":
      if (!hasActiveTurn(state) || state.waitingHuman) return ignored(state);
      // No effect is emitted here by design. The bridge records the wait but
      // never manufactures a permission response; the human-owned TUI answers.
      return changed(state, { waitingHuman: true });

    case "approval_resolved_by_human":
      if (!state.waitingHuman) return ignored(state);
      return changed(state, { waitingHuman: false });

    // Grok 0.2.93 emits the ordinary permission lifecycle around its
    // session-local todo_write helper even though the TUI resolves that
    // helper without asking the human.  The runtime admits only that exact,
    // separately checked preview case; all other automatic resolutions stay
    // on the fail-closed approval path.
    case "preview_todo_resolved_automatically":
      if (
        !state.waitingHuman
        || (state.phase !== "network_turn" && state.phase !== "human_turn")
        || (state.activeTurn?.owner !== "network" && state.activeTurn?.owner !== "human")
      ) return ignored(state);
      return changed(state, { waitingHuman: false });
  }
}

export function snapshotGrokCopresenceState(
  state: GrokCopresenceState,
): GrokCopresenceSnapshot {
  assertGrokCopresenceState(state);
  return {
    version: 1,
    phase: state.phase,
    queue: state.queue.map(copyTask),
    activeTurn: copyActiveTurn(state.activeTurn),
    recoveryFrom: state.recoveryFrom,
    waitingHuman: state.waitingHuman,
    revision: state.revision,
  };
}

export function restoreGrokCopresenceState(
  snapshot: GrokCopresenceSnapshot,
): GrokCopresenceState {
  if (snapshot.version !== 1) {
    throw new Error(`unsupported Grok co-presence snapshot version: ${String(snapshot.version)}`);
  }
  const state: GrokCopresenceState = {
    phase: snapshot.phase,
    queue: snapshot.queue.map(copyTask),
    activeTurn: copyActiveTurn(snapshot.activeTurn),
    recoveryFrom: snapshot.recoveryFrom,
    waitingHuman: snapshot.waitingHuman,
    revision: snapshot.revision,
  };
  assertGrokCopresenceState(state);
  return state;
}

export function assertGrokCopresenceState(state: GrokCopresenceState): void {
  if (!(GROK_COPRESENCE_PHASES as readonly unknown[]).includes(state.phase)) {
    throw new Error(`invalid Grok co-presence phase: ${String(state.phase)}`);
  }
  if (!Array.isArray(state.queue)) throw new Error("Grok co-presence queue must be an array");
  if (typeof state.waitingHuman !== "boolean") {
    throw new Error("Grok co-presence waitingHuman must be boolean");
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error("Grok co-presence state has an invalid revision");
  }
  for (const task of state.queue) assertTask(task);

  if (state.activeTurn !== null
    && state.activeTurn.owner !== "human"
    && state.activeTurn.owner !== "network") {
    throw new Error("Grok co-presence active turn has an invalid owner");
  }

  if (state.phase === "idle" || state.phase === "human_editing") {
    if (state.activeTurn !== null) throw new Error(`${state.phase} cannot have an active turn`);
  }
  if (state.phase === "human_turn" && state.activeTurn?.owner !== "human") {
    throw new Error("human_turn must be owned by a human");
  }
  if (state.phase === "network_turn" && state.activeTurn?.owner !== "network") {
    throw new Error("network_turn must retain its network task");
  }
  if (state.activeTurn?.owner === "network") assertTask(state.activeTurn.task);

  if (state.phase === "recovering") {
    if (state.recoveryFrom === null) throw new Error("recovering must record its prior phase");
    if (!(GROK_COPRESENCE_RECOVERABLE_PHASES as readonly unknown[]).includes(state.recoveryFrom)) {
      throw new Error(`invalid Grok co-presence recovery phase: ${String(state.recoveryFrom)}`);
    }
    if (state.recoveryFrom === "network_turn" && state.activeTurn?.owner !== "network") {
      throw new Error("recovering network turn must retain its network task");
    }
    if (state.recoveryFrom === "human_turn" && state.activeTurn?.owner !== "human") {
      throw new Error("recovering human turn must retain its owner");
    }
  } else if (state.recoveryFrom !== null) {
    throw new Error("only recovering may record a prior phase");
  }

  if (state.waitingHuman && !hasActiveTurn(state)) {
    throw new Error("waitingHuman requires an active turn");
  }
}

function hasActiveTurn(state: GrokCopresenceState): boolean {
  return state.activeTurn !== null
    && (state.phase === "human_turn"
      || state.phase === "network_turn"
      || state.phase === "recovering");
}

function changed(
  state: GrokCopresenceState,
  patch: Partial<Omit<GrokCopresenceState, "revision">>,
  effects: GrokCopresenceEffect[] = [],
): GrokCopresenceTransition {
  const next: GrokCopresenceState = {
    ...state,
    ...patch,
    queue: patch.queue ?? state.queue.map(copyTask),
    activeTurn: patch.activeTurn === undefined
      ? copyActiveTurn(state.activeTurn)
      : copyActiveTurn(patch.activeTurn),
    revision: state.revision + 1,
  };
  assertGrokCopresenceState(next);
  return { state: next, accepted: true, effects };
}

function ignored(state: GrokCopresenceState): GrokCopresenceTransition {
  return { state, accepted: false, effects: [] };
}

function assertTask(task: GrokCopresenceNetworkTask): void {
  if (typeof task.taskId !== "string" || !task.taskId.trim()) {
    throw new Error("network task requires taskId");
  }
  if (typeof task.from !== "string" || !task.from.trim()) {
    throw new Error("network task requires from");
  }
  if (typeof task.message !== "string") throw new Error("network task requires message");
}

function copyActiveTurn(
  turn: GrokCopresenceActiveTurn | null,
): GrokCopresenceActiveTurn | null {
  if (turn === null || turn.owner === "human") return turn === null ? null : { owner: "human" };
  return { owner: "network", task: copyTask(turn.task) };
}

function copyTask(task: GrokCopresenceNetworkTask): GrokCopresenceNetworkTask {
  return {
    taskId: task.taskId,
    from: task.from,
    message: task.message,
    ...(task.metadata === undefined ? {} : { metadata: copyJson(task.metadata) }),
  };
}

function copyJson<T extends GrokCopresenceJson>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => copyJson(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copyJson(entry)]),
    ) as T;
  }
  return value;
}

const GROK_COPRESENCE_PHASES: readonly GrokCopresencePhase[] = [
  "idle",
  "human_editing",
  "human_turn",
  "network_turn",
  "recovering",
];

const GROK_COPRESENCE_RECOVERABLE_PHASES: readonly RecoverablePhase[] = [
  "idle",
  "human_editing",
  "human_turn",
  "network_turn",
];
