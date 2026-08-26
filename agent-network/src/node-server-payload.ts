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

/** Injected so the decision is testable without spawning anything. */
export interface TypeScriptBundler {
  /** Returns the self-contained JavaScript for `entryPath`, or throws. */
  bundleSync(entryPath: string): string;
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
 * A `.js` source is passed through untouched — the published package ships a
 * compiled bundle there, and re-processing it risks changing bytes for no gain.
 *
 * 🔴 A `.ts` source must be **bundled, not merely transpiled**. Stripping types
 * fixes the parse error but leaves the file's relative imports pointing at
 * siblings that do not exist beside the destination:
 *
 *     import { inboundChannelMeta } from "./channel-meta.js";
 *     → Cannot find module './channel-meta.js' from '<project>/.anet/node-server.js'
 *
 * That second failure is why transpiling alone still ended at
 * "CommHub MCP readiness preflight failed (1)". The published
 * `dist/src/node-server.js` works precisely because it is a self-contained
 * bundle, so a source checkout has to produce the same shape.
 */
export function nodeServerPayloadFor(
  source: string,
  sourcePath: string,
  bundler: TypeScriptBundler | null,
): string {
  if (!sourcePath.endsWith(".ts")) return source;
  if (!bundler) {
    // Refuse rather than write a file that is certain to fail at spawn time.
    // Writing it "and letting the runtime complain" is what issue #1216 was:
    // the error surfaced in another process, three layers up, naming neither
    // the file nor the reason.
    throw new NodeServerPayloadError(
      `cannot generate the .anet/node-server.js payload from the TypeScript source at ${sourcePath}: `
      + `this runtime cannot bundle. Build the package first `
      + `(\`bun run build\` in agent-network produces dist/src/node-server.js), or run the CLI under bun.`,
    );
  }
  return bundler.bundleSync(sourcePath);
}

/**
 * The bundler available on this runtime, or null.
 *
 * bun can bundle; the published CLI runs under node and cannot — but it also
 * never resolves a `.ts` candidate (its `dist/` copy wins), so null there is
 * correct rather than a gap.
 *
 * `spawnSync` rather than `Bun.build()` because both call sites are
 * synchronous, and making them async would change the ordering of the file
 * writes around them.
 */
export function ambientTypeScriptTranspiler(): TypeScriptBundler | null {
  const bun = (globalThis as { Bun?: { spawnSync?: unknown } }).Bun;
  if (!bun?.spawnSync) return null;
  return {
    bundleSync(entryPath: string): string {
      const spawnSync = (bun as { spawnSync: (cmd: string[], opts?: unknown) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } }).spawnSync;
      const result = spawnSync(["bun", "build", entryPath, "--target", "bun"], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) {
        throw new NodeServerPayloadError(
          `bundling ${entryPath} failed: ${new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`}`,
        );
      }
      const out = new TextDecoder().decode(result.stdout);
      if (!out.trim()) {
        throw new NodeServerPayloadError(`bundling ${entryPath} produced no output`);
      }
      return out;
    },
  };
}
