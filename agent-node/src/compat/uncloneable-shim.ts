// Node <22.4 compatibility shim for `worker_threads.markAsUncloneable`.
//
// Transitive `undici@^8.5.0` calls `webidl.util.markAsUncloneable(this)` in
// Request/Response/FormData/EventSource constructors. Internally it does
// `require("node:worker_threads").markAsUncloneable` at module load time —
// that API only landed in **Node v22.4.0**. On Node 18.x–22.3.x the value
// is `undefined`, so any undici fetch invocation throws:
//
//   TypeError: webidl.util.markAsUncloneable is not a function
//
// This kills the entire RFC-028 probe path (probe-daemon.ts imports
// `Agent` + `fetch` from undici) for users on Node <22.4. Our docker
// e2e (`node:22-bookworm-slim`) ships ≥22.4 so the test suite never
// caught it; N站马 real-amber e2e on a Node 20 host triggered it.
//
// Semantic safety: `markAsUncloneable(obj)` marks `obj` so that
// `structuredClone(obj)` throws `DataCloneError`. It's an optimization
// hint for cross-thread postMessage. A no-op on environments lacking
// the API means undici Request/Response/FormData become structured-
// cloneable — which is unused in any agent-node code path (we never
// `postMessage` undici objects across workers).
//
// Install order: this file MUST be imported BEFORE any module that
// transitively loads undici. cli.ts imports it on line 1; everywhere
// else that touches undici (probe-daemon.ts) is loaded after cli.ts
// bootstraps.
//
// Tracks Node version sanity for telemetry / docs: a one-time stderr
// log surfaces "<22.4, polyfill applied" so ops can see at boot
// whether the shim was the active codepath (vs natively supported).

// Important: must use CJS `require` to get a MUTABLE worker_threads object
// (ESM namespace `import * as workerThreads` is frozen per spec — assigning
// to it throws "readonly property"). undici does CJS `require("node:worker_threads")`
// at module load, so the CJS export object is the one we need to mutate;
// Node's module cache shares the same exports object between CJS callers.
import { createRequire } from "node:module";

const NODE_MIN_NATIVE = "22.4.0";

function nodeAtLeast(version: string): boolean {
  const cur = process.versions.node.split(".").map(n => parseInt(n, 10));
  const min = version.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    if ((cur[i] ?? 0) > min[i]) return true;
    if ((cur[i] ?? 0) < min[i]) return false;
  }
  return true;
}

// Use a CJS require to get the mutable exports object. import.meta.url for
// Node ESM, fall back to "/" for environments where it's missing.
const requireCjs = createRequire((typeof import.meta !== "undefined" && (import.meta as any).url) || "file:///");
const wt = requireCjs("node:worker_threads") as { markAsUncloneable?: (v: unknown) => void };

if (typeof wt.markAsUncloneable !== "function") {
  // No-op polyfill. Lets undici's webidl.util.markAsUncloneable invocation
  // succeed without throwing. Side effect: undici objects gain structured-
  // clone-ability — harmless because nothing in agent-node clones them.
  try {
    wt.markAsUncloneable = (_v: unknown) => { /* no-op */ };
  } catch {
    // Some loaders (Bun ESM strict mode) freeze even the CJS export object;
    // defineProperty bypasses the read-only setter trap.
    Object.defineProperty(wt, "markAsUncloneable", {
      value: (_v: unknown) => { /* no-op */ },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  if (!nodeAtLeast(NODE_MIN_NATIVE)) {
    console.warn(
      `[agent-node] Node ${process.versions.node} < ${NODE_MIN_NATIVE} ` +
      `— installed worker_threads.markAsUncloneable shim ` +
      `(transitive undici requires this; upgrade Node to ≥${NODE_MIN_NATIVE} to skip the polyfill)`
    );
  }
}

// Marker export so static analyzers see this module has side effects
// and tree-shakers don't drop it. (bun build --target node respects
// this; `import "./compat/uncloneable-shim.js"` is preserved.)
export const __uncloneable_shim_loaded__ = true;
