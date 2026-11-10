/**
 * Build stamp for the standalone `anet` executable.
 *
 * The committed value is inactive. `scripts/build-anet-bin.mjs` rewrites this
 * file only for the duration of `bun build --compile`, then restores it.
 * npm/node runs of `bin/cli.ts` must keep seeing `standalone: false`.
 *
 * Versions are read from each package's package.json at binary-build time.
 * Do not hard-code release versions here — those constants belong to the
 * packages (and to the in-flight release that owns them).
 */

export interface StandalonePackageVersions {
  /** `@sleep2agi/agent-network` package.json version. */
  anet: string;
  /** `@sleep2agi/agent-node` package.json version. */
  agentNode: string;
  /** `@sleep2agi/commhub-server` package.json version. */
  commhubServer: string;
  /** Release label of this executable (`cli-bin-v<bundle>`). */
  bundle: string;
}

export interface StandaloneBuildStamp {
  standalone: boolean;
  versions: StandalonePackageVersions | null;
  /**
   * Prebundled `.anet/node-server.js` payload (target node, version marker
   * already stamped). Null outside the standalone binary. The compiled
   * executable has no real package layout, so the CLI cannot find
   * `node-server.js` via `import.meta.url`.
   */
  nodeServerJs: string | null;
}

export const STANDALONE_BUILD_STAMP: StandaloneBuildStamp = {
  standalone: false,
  versions: null,
  nodeServerJs: null,
};
