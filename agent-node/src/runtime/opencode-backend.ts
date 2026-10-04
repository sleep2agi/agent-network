// Board #542 — the seam between agent-node's OpenCode runtimes and the
// upstream OpenCode generation they drive.
//
// Everything that differs between OpenCode generations goes through this
// interface: which npm package and versions are accepted, how the exact
// executable is resolved and re-checked, which environment carries the safety
// policy, and the argv of every upstream invocation (acp, serve, attach).
//
// Only V1 (`opencode-ai`) is implemented, and it is the pre-#542 code moved
// behind the interface unchanged — opencode-v1-spawn-snapshot.test.ts pins
// the spawned argv/env/launcher to the golden recorded before the move.
// V2 (`@opencode/cli`) is deliberately NOT implemented: it silently ignores
// the V1 safety env (OPENCODE_PERMISSION, OPENCODE_PURE, …), so a V2 backend
// must bring its own enforced policy (#543). Asking for it throws.

import {
  buildOpencodeChildEnv,
  type BuildOpencodeChildEnvOptions,
} from "./opencode-acp/child-env";
import {
  resolvePinnedOpencodeBinaryAttestation,
  revalidatePinnedOpencodeBinary,
  type PinnedOpencodeBinaryAttestation,
  type ResolvePinnedOpencodeBinaryOptions,
  type RevalidatePinnedOpencodeBinaryOptions,
} from "./opencode-acp/binary";
import {
  isAcceptedOpencodeVersionFor,
  opencodeGenerationSupport,
  type OpencodeGeneration,
  type OpencodeGenerationSupport,
} from "./opencode-versions";

export interface OpencodeServeInvocation {
  hostname: string;
  port: number;
}

export interface OpencodeAttachInvocation {
  url: string;
  sessionId: string;
  cwd: string;
}

export interface OpencodeBackend {
  readonly generation: OpencodeGeneration;
  /** npm package that provides the `opencode` executable. */
  readonly packageName: string;
  /** This generation's row in the shared supported-versions table. */
  readonly support: OpencodeGenerationSupport;
  /** Environment keys through which this generation enforces the safe
   *  preset. A key listed here must actually be honoured upstream. */
  readonly safetyEnvKeys: readonly string[];
  /** Exact-version admission against the supported-versions table. */
  isSupportedVersion(version: string): boolean;
  /** Credential-free probe + package identity gate; returns the attestation
   *  that must later be re-checked by `revalidateBinary`. */
  resolveBinary(opts: ResolvePinnedOpencodeBinaryOptions): PinnedOpencodeBinaryAttestation;
  /** Re-check the attested executable immediately before spawn, without
   *  executing it. Returns the exact path to spawn. */
  revalidateBinary(
    attestation: PinnedOpencodeBinaryAttestation,
    opts: RevalidatePinnedOpencodeBinaryOptions,
  ): string;
  /** Complete child environment (isolation roots + safety policy). */
  buildChildEnv(opts: BuildOpencodeChildEnvOptions): NodeJS.ProcessEnv;
  /** argv (after the executable) of the headless ACP runtime. */
  acpArgs(): string[];
  /** argv (after the executable) of the shared-TUI server. */
  serveArgs(invocation: OpencodeServeInvocation): string[];
  /** argv (after the executable) of the human TUI attaching to that server. */
  attachArgs(invocation: OpencodeAttachInvocation): string[];
}

/** V1 safe-preset env, exactly the keys child-env.ts sets in safe mode plus
 *  the inline/late policy it sets in every mode. */
const V1_SAFETY_ENV_KEYS = Object.freeze([
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_PERMISSION",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR",
  "OPENCODE_DISABLE_AUTOUPDATE",
]);

const V1_SUPPORT = opencodeGenerationSupport("v1");

export const OPENCODE_V1_BACKEND: OpencodeBackend = Object.freeze({
  generation: "v1",
  packageName: V1_SUPPORT.packageName,
  support: V1_SUPPORT,
  safetyEnvKeys: V1_SAFETY_ENV_KEYS,
  isSupportedVersion: (version: string) => isAcceptedOpencodeVersionFor("v1", version),
  resolveBinary: (opts: ResolvePinnedOpencodeBinaryOptions) => resolvePinnedOpencodeBinaryAttestation(opts),
  revalidateBinary: (
    attestation: PinnedOpencodeBinaryAttestation,
    opts: RevalidatePinnedOpencodeBinaryOptions,
  ) => revalidatePinnedOpencodeBinary(attestation, opts),
  buildChildEnv: (opts: BuildOpencodeChildEnvOptions) => buildOpencodeChildEnv(opts),
  acpArgs: () => ["acp"],
  serveArgs: ({ hostname, port }: OpencodeServeInvocation) =>
    ["serve", "--hostname", hostname, "--port", String(port), "--pure"],
  attachArgs: ({ url, sessionId, cwd }: OpencodeAttachInvocation) =>
    ["attach", url, "--session", sessionId, "--dir", cwd, "--pure"],
} satisfies OpencodeBackend);

/** The backend for `generation`. Throws for any generation without one
 *  (today: v2), so a caller can never silently fall back to V1 argv/env. */
export function opencodeBackendFor(generation: OpencodeGeneration): OpencodeBackend {
  if (generation === "v1") return OPENCODE_V1_BACKEND;
  const support = opencodeGenerationSupport(generation);
  throw new Error(
    `OpenCode ${generation} (${support.packageName}) is ${support.status} in this agent-node; ` +
    `only OpenCode v1 (${OPENCODE_V1_BACKEND.packageName}) has a backend`,
  );
}
