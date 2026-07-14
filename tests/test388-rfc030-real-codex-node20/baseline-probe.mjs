import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const binaryInput = process.env.RFC030_CODEX_BIN;
const bundleInput = process.env.RFC030_BASELINE_BUNDLE;
if (!binaryInput || !bundleInput) {
  throw new Error("RFC030_CODEX_BIN and RFC030_BASELINE_BUNDLE are required");
}

// Use the same canonical binary for both the baseline gate and the later PTY
// smoke. assertCodexBaseline owns the version/schema pins and digest algorithm;
// this probe deliberately does not duplicate either one.
const binary = realpathSync(binaryInput);
const { assertCodexBaseline } = await import(pathToFileURL(bundleInput).href);
if (typeof assertCodexBaseline !== "function") {
  throw new Error("compiled version-gate bundle does not export assertCodexBaseline");
}

const verified = await assertCodexBaseline(binary, { timeoutMs: 60_000 });
if (
  typeof verified?.version !== "string"
  || typeof verified?.schemaSha256 !== "string"
  || !/^[0-9a-f]{64}$/.test(verified.schemaSha256)
) {
  throw new Error("assertCodexBaseline returned an invalid verification result");
}

console.log(`assertCodexBaseline: PASS version=${verified.version}`);
console.log(`generated-schema gate: PASS sha256=${verified.schemaSha256}`);
