// Board #542 — the ONE table of OpenCode generations and the upstream versions
// this release accepts for each.
//
// 🔴 MIRROR: this file exists twice, byte-identical:
//      agent-node/src/runtime/opencode-versions.ts
//      agent-network/src/opencode-versions.ts
//    The two packages cannot import each other, so the anet launcher's pin
//    check and agent-node's package gate each read their own copy; the parity
//    test agent-network/src/opencode-versions-parity.test.ts fails the moment
//    the copies differ. Edit one, copy it over, run that test. Only node
//    built-ins (none at present) may be imported here.
//
// Generations:
//   v1 — npm `opencode-ai` 1.x (serve/attach/acp, OPENCODE_* safety env).
//   v2 — npm `@opencode/cli` 2.x. A different server API and TUI, and it
//        silently ignores the V1 safety env (OPENCODE_PERMISSION,
//        OPENCODE_PURE, …), so it is NOT supported until a V2 backend with
//        its own enforced policy exists (#543).

export type OpencodeGeneration = "v1" | "v2";

export type OpencodeSupportStatus = "supported" | "preview" | "unsupported";

export interface OpencodeGenerationSupport {
  readonly generation: OpencodeGeneration;
  /** npm package that provides the `opencode` executable. */
  readonly packageName: string;
  /** Release pin: the exact version a fresh install is told to use.
   *  null when no version of this generation is vetted. */
  readonly pin: string | null;
  /** Every exact version a start may accept, preferred first (pin first).
   *  Empty when the generation is unsupported. */
  readonly acceptedVersions: readonly string[];
  readonly status: OpencodeSupportStatus;
}

/** The V1 release pin. Kept as its own literal line so shell suites can
 *  read it with a single anchored sed (tests/test1225…/run.sh). */
export const OPENCODE_V1_PIN = "1.18.34";

const OPENCODE_V1_SUPPORT: OpencodeGenerationSupport = Object.freeze({
  generation: "v1",
  packageName: "opencode-ai",
  pin: OPENCODE_V1_PIN,
  // Pin first, then the previous pin for one transition window (#541): a
  // host still holding the old exact install keeps starting and is told to
  // upgrade. Each entry passed the full Docker/E2E gate when it was the pin.
  acceptedVersions: Object.freeze([OPENCODE_V1_PIN, "1.18.1"]),
  status: "supported",
});

const OPENCODE_V2_SUPPORT: OpencodeGenerationSupport = Object.freeze({
  generation: "v2",
  packageName: "@opencode/cli",
  pin: null,
  acceptedVersions: Object.freeze([]),
  status: "unsupported",
});

export const OPENCODE_SUPPORTED_VERSIONS: readonly OpencodeGenerationSupport[] = Object.freeze([
  OPENCODE_V1_SUPPORT,
  OPENCODE_V2_SUPPORT,
]);

/** Generation assumed for every node record that does not name one. */
export const OPENCODE_DEFAULT_GENERATION: OpencodeGeneration = "v1";

export function isOpencodeGeneration(value: unknown): value is OpencodeGeneration {
  return value === "v1" || value === "v2";
}

export function opencodeGenerationSupport(generation: OpencodeGeneration): OpencodeGenerationSupport {
  const entry = OPENCODE_SUPPORTED_VERSIONS.find((row) => row.generation === generation);
  if (!entry) throw new Error(`unknown opencode generation ${String(generation)}`);
  return entry;
}

/** Exact versions a start may accept for `generation`, preferred first.
 *  Always empty for an unsupported generation. */
export function acceptedOpencodeVersionsFor(generation: OpencodeGeneration): readonly string[] {
  const entry = opencodeGenerationSupport(generation);
  return entry.status === "unsupported" ? [] : entry.acceptedVersions;
}

export function isAcceptedOpencodeVersionFor(generation: OpencodeGeneration, version: string): boolean {
  return acceptedOpencodeVersionsFor(generation).includes(version);
}

/** Generation recorded on a node config; a config without one (every node
 *  created before #542) is V1. An unrecognised value is returned as
 *  undefined so callers can refuse it instead of guessing. */
export function opencodeGenerationOfConfig(
  config: { opencodeGeneration?: unknown } | null | undefined,
): OpencodeGeneration | undefined {
  const value = config?.opencodeGeneration;
  if (value === undefined || value === null) return OPENCODE_DEFAULT_GENERATION;
  return isOpencodeGeneration(value) ? value : undefined;
}
