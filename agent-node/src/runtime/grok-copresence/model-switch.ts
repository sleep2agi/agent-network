/**
 * Out-of-band model switching for the co-presence TUI (issue #879).
 *
 * Why this exists: on a co-presence node the human cannot switch models.
 * `/model` is refused by the composer gate, and Grok's own `Ctrl+M` picker is
 * `0x0d` — the same byte as Enter — so the proxy consumes it as a submit. Both
 * routes are keyboard routes, and a keyboard fix needs something the proxy does
 * not have: a view of which pane the TUI has focused.
 *
 * This module takes the other road. Grok resolves configuration with CLI flags
 * at the highest priority (`~/.grok/docs/user-guide/05-configuration.md`, read
 * out of the pinned 0.2.93 binary):
 *
 *     1. CLI flags (e.g., `--yolo`, `--model`, `--sandbox`)
 *     2. Environment variables
 *     3. config.toml
 *     4. Remote settings
 *     5. Built-in defaults
 *
 * A session records `current_model_id` in its `summary.json`, but that is
 * session metadata and does not appear in the precedence list above. So
 * re-spawning the leader as `--resume <sessionId> --model <new>` keeps the
 * conversation and changes the model, without any keystroke crossing the gate.
 *
 * 🔴 This module decides only. It never spawns, kills, or writes anything, so
 * every rule below is assertable without a PTY, a binary, or a clock.
 */

import type { GrokCopresencePhase } from "./state.js";

export type GrokModelSwitchRefusalCode =
  | "invalid_model"
  | "unchanged"
  | "busy";

export interface GrokModelSwitchPlan {
  ok: true;
  model: string;
  /**
   * 🔴 Always `true`, and deliberately not derived from any input.
   *
   * A model switch that started a fresh session would silently drop the
   * conversation the human is sitting in — the exact loss this feature exists
   * to avoid. Making it a constant means no caller and no future refactor can
   * turn a model switch into a new session by passing a flag.
   */
  resume: true;
}

export interface GrokModelSwitchRefusal {
  ok: false;
  code: GrokModelSwitchRefusalCode;
  message: string;
}

export type GrokModelSwitchDecision = GrokModelSwitchPlan | GrokModelSwitchRefusal;

/**
 * Phases in which a switch is allowed.
 *
 * Re-spawning the leader tears down the TUI process, so it must not happen
 * while a turn is in flight: `network_turn` would lose a task that CommHub
 * believes is running, `human_turn` / `human_editing` would throw away what the
 * person is in the middle of, and `recovering` means the runtime does not yet
 * know what state it is in.
 */
const SWITCHABLE_PHASES: ReadonlySet<GrokCopresencePhase> = new Set(["idle"]);

/** Grok model ids are short slugs; the cap only keeps argv and logs sane. */
const MAX_MODEL_ID_LENGTH = 128;

/**
 * 🔴 Reject anything that is not a plain slug.
 *
 * The accepted value is appended to argv as the operand of `--model`. A value
 * starting with `-` would be read by Grok's own parser as the next flag rather
 * than as this flag's operand, which turns a model switch into an arbitrary
 * flag injection — including flags this runtime pins for safety. Whitespace and
 * control characters are refused for the same reason: what argv carries must be
 * exactly what was requested, with no room for a second token to appear.
 */
const VALID_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export function decideGrokModelSwitch(input: {
  requested: unknown;
  current?: string;
  phase: GrokCopresencePhase;
}): GrokModelSwitchDecision {
  const raw = typeof input.requested === "string" ? input.requested.trim() : "";
  if (!raw) {
    return refuse("invalid_model", "a model id is required");
  }
  if (raw.length > MAX_MODEL_ID_LENGTH) {
    return refuse("invalid_model", `model id is longer than ${MAX_MODEL_ID_LENGTH} characters`);
  }
  if (!VALID_MODEL_ID.test(raw)) {
    return refuse(
      "invalid_model",
      `model id ${JSON.stringify(raw)} is not a plain slug; it must start with a letter or digit and contain no whitespace, control characters, or leading dash`,
    );
  }
  // Checked before `busy` on purpose: an unchanged model needs no restart, so
  // there is nothing for a running turn to conflict with, and answering "busy"
  // would send the caller off to retry something that was already a no-op.
  if (input.current !== undefined && input.current === raw) {
    return refuse("unchanged", `the co-presence TUI is already running ${raw}`);
  }
  if (!SWITCHABLE_PHASES.has(input.phase)) {
    return refuse(
      "busy",
      `switching models restarts the shared TUI, which is only safe while idle (current phase: ${input.phase})`,
    );
  }
  return { ok: true, model: raw, resume: true };
}

function refuse(code: GrokModelSwitchRefusalCode, message: string): GrokModelSwitchRefusal {
  return { ok: false, code, message };
}

export class GrokModelSwitchArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokModelSwitchArgvError";
  }
}

/**
 * 🔴 The security gate: prove that a model switch changed the model and nothing else.
 *
 * The co-presence TUI runs with `--permission-mode bypassPermissions` and
 * `--always-approve` because the human and the network share one session; the
 * composer gate exists so a person cannot move that boundary. Re-spawning the
 * leader rebuilds argv from scratch, which means a bug or a future edit could
 * move `--sandbox`, `--agent`, `--permission-mode`, or `--always-approve` on a
 * path whose stated purpose is "change the model".
 *
 * So the caller does not get to assert that by reading the code. It hands both
 * argv arrays to this function, which fails unless the only difference is the
 * operand of `--model`.
 *
 * Comparing positionally rather than as a set is deliberate: argv order is
 * meaningful to Grok's parser, and a re-ordering that preserved the multiset
 * would pass a set comparison while changing which flag owns which operand.
 */
export function assertModelOnlyArgvDelta(
  before: readonly string[],
  after: readonly string[],
  expectedModel: string,
): void {
  const beforeModel = readModelOperand(before, "previous");
  const afterModel = readModelOperand(after, "next");
  if (afterModel === undefined) {
    throw new GrokModelSwitchArgvError("the rebuilt argv carries no --model flag");
  }
  if (afterModel !== expectedModel) {
    throw new GrokModelSwitchArgvError(
      `the rebuilt argv carries --model ${JSON.stringify(afterModel)}, not the requested ${JSON.stringify(expectedModel)}`,
    );
  }
  const beforeRest = withoutModelPair(before);
  const afterRest = withoutModelPair(after);
  if (beforeRest.length !== afterRest.length) {
    throw new GrokModelSwitchArgvError(
      `a model switch changed the argument count (${beforeRest.length} → ${afterRest.length}); only the --model operand may change`,
    );
  }
  for (let index = 0; index < beforeRest.length; index++) {
    if (beforeRest[index] !== afterRest[index]) {
      throw new GrokModelSwitchArgvError(
        `a model switch changed argv[${index}] from ${JSON.stringify(beforeRest[index])} to ${JSON.stringify(afterRest[index])}; only the --model operand may change`,
      );
    }
  }
  // Naming the previous model is not required — a node started without
  // `--model` has none — but if one was there it must not have moved position,
  // which the positional comparison above already covers.
  void beforeModel;
}

/**
 * Drop the session flag and its operand.
 *
 * A node's first spawn names its session with `--session-id` and every
 * re-spawn resumes it with `--resume`. That difference is expected across a
 * model switch and would otherwise be reported as an illegal argv change, so
 * callers strip it here and assert the resumed session id on its own.
 */
export function withoutSessionFlag(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--session-id" || argv[index] === "--resume") {
      index++;
      continue;
    }
    rest.push(argv[index]);
  }
  return rest;
}

function readModelOperand(argv: readonly string[], label: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--model") continue;
    if (found !== undefined) {
      throw new GrokModelSwitchArgvError(`the ${label} argv carries more than one --model flag`);
    }
    const operand = argv[index + 1];
    if (operand === undefined) {
      throw new GrokModelSwitchArgvError(`the ${label} argv ends with a --model flag that has no operand`);
    }
    found = operand;
  }
  return found;
}

function withoutModelPair(argv: readonly string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--model") {
      index++;
      continue;
    }
    rest.push(argv[index]);
  }
  return rest;
}
