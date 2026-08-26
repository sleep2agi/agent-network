/**
 * What gets written to `<project>/.anet/node-server.js` (issue #1216).
 *
 * The target name is not negotiable: `agent-node`'s grok co-presence spawn
 * gate pins the CommHub MCP payload to exactly that path, so whatever the
 * source is, the file that lands there is called `.js`.
 *
 * 🔴 The bug this module exists to remove: the old code copied the source
 * verbatim and justified it with a comment claiming
 *
 *     "bun runs .ts content under a .js extension fine"
 *
 * which is false — bun selects its parser from the extension:
 *
 *     $ printf 'function f(x: string): void {}\nf("hi");\n' > probe.ts
 *     $ cp probe.ts probe.js
 *     $ bun probe.ts   → runs
 *     $ bun probe.js   → error: Expected ")" but found ":"
 *
 * An installed npm package never hit it, because its first resolver candidate
 * (`dist/src/node-server.js`) is compiled. Only a source checkout fell through
 * to `src/node-server.ts` — i.e. every local run and every hand-verified PR.
 *
 * And the symptom was three layers from the cause: the node died on
 * `grok copresence CommHub MCP readiness preflight failed (1)`, which names
 * neither a file nor a parse error.
 */

/** Minimal shape of the transpiler this module needs; injected so it is testable. */
export interface TypeScriptTranspiler {
  transformSync(source: string): string;
}

export class NodeServerPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeServerPayloadError";
  }
}

/**
 * Decide what bytes belong at the `.js` target for a given source path.
 *
 * A `.js` source is passed through untouched — it is already what the target
 * expects, and re-processing a compiled bundle risks changing it for no gain.
 * A `.ts` source must be transpiled, because the destination extension makes
 * type syntax a parse error rather than something the runtime ignores.
 */
export function nodeServerPayloadFor(
  source: string,
  sourcePath: string,
  transpiler: TypeScriptTranspiler | null,
): string {
  if (!sourcePath.endsWith(".ts")) return source;
  if (!transpiler) {
    // 🔴 Refuse rather than write a file that is certain to fail at spawn
    // time. Writing it "and letting the runtime complain" is what produced the
    // unreadable MCP-readiness failure this module is named after: the error
    // surfaced in a different process, three layers up, naming neither the
    // file nor the reason.
    throw new NodeServerPayloadError(
      `cannot generate the .anet/node-server.js payload from the TypeScript source at ${sourcePath}: `
      + `this runtime has no TypeScript transpiler. Build the package first `
      + `(\`bun run build\` in agent-network produces dist/src/node-server.js), or run the CLI under bun.`,
    );
  }
  return transpiler.transformSync(source);
}

/**
 * The transpiler available on this runtime, or null.
 *
 * bun exposes one; the published CLI runs under node and does not — but the
 * published CLI also never resolves a `.ts` candidate, so null there is
 * correct rather than a gap.
 */
export function ambientTypeScriptTranspiler(): TypeScriptTranspiler | null {
  const bun = (globalThis as { Bun?: { Transpiler?: new (opts: { loader: string }) => TypeScriptTranspiler } }).Bun;
  if (!bun?.Transpiler) return null;
  return new bun.Transpiler({ loader: "ts" });
}
