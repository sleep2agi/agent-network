// TEST-ONLY source overlay in a disposable container. NEVER included in product
// bundles. Product acceptedVersions and production gates remain unchanged.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
const identity = "2.0.22-anet-test.29040e2";
const sha = "1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786";
const { acceptedOpencodeVersionsFor, isAcceptedOpencodeVersionFor } = await import("../../agent-node/src/runtime/opencode-versions");
if (JSON.stringify(acceptedOpencodeVersionsFor("v2")) !== '["2.0.22"]' || isAcceptedOpencodeVersionFor("v2", identity)) throw Error("product_pin_was_modified");
console.log("PRODUCT_PIN_UNCHANGED", "stock pin 2.0.22; custom build refused before TEST-ONLY overlay");
const bytes = readFileSync("/native/opencode");
if (createHash("sha256").update(bytes).digest("hex") !== sha) throw Error("test_native_sha_refused");
const raw = execFileSync("/native/opencode", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
if (!new RegExp(`^(?:opencode v)?${identity.replaceAll(".", "\\.")}$`).test(raw)) throw Error("test_native_identity_refused");
console.log("TEST_ONLY_NATIVE", JSON.stringify({ base: "2.0.22", identity, sha256: sha, raw, stock: false }));
// A truthful LOCAL build manifest, NOT an installed/published @opencode/cli npm
// package, and NOT a synthetic executable. Both CLI gates retain exact manifest,
// realpath, ownership and actual --version; runtime attestation also pins digest.
const pkg = "/work/native-local/node_modules/@anet-test-only/opencode";
mkdirSync(`${pkg}/bin`, { recursive: true, mode: 0o755 });
copyFileSync("/native/opencode", `${pkg}/bin/opencode.exe`); chmodSync(`${pkg}/bin/opencode.exe`, 0o755);
writeFileSync(`${pkg}/package.json`, JSON.stringify({ name: "@anet-test-only/opencode", version: identity,
  bin: { opencode: "bin/opencode.exe" }, private: true, testOnly: true, base: "2.0.22", sha256: sha,
  source: "29040e240ecf238c84ab63a7f9e2420e4c3479d6" }));
const files = ["agent-node/src/runtime/opencode-versions.ts", "agent-network/src/opencode-versions.ts",
  "agent-node/src/runtime/session-source-directory.ts", "agent-node/src/runtime/session-project-create.ts",
  "agent-node/src/runtime/source-resume-launcher.ts", "agent-node/src/cli.ts", "agent-network/bin/cli.ts",
  "agent-node/src/runtime/opencode-acp/binary.ts", "agent-node/src/runtime/session-source-delivery.ts"];
for (const file of files) {
  let text = readFileSync(file, "utf8");
  text = text.replaceAll('"2.0.22"', JSON.stringify(identity));
  if (file.endsWith("opencode-versions.ts")) text = text.replace('packageName: "@opencode/cli"', 'packageName: "@anet-test-only/opencode"');
  // Preserve the suffix rather than silently stripping custom builds to stock.
  text = text.replaceAll('raw.match(/(\\d+\\.\\d+\\.\\d+)/)?.[1] ?? raw',
    `raw.match(/(${identity.replaceAll(".", "\\.")})/)?.[1] ?? raw.match(/(\\d+\\.\\d+\\.\\d+)/)?.[1] ?? raw`);
  writeFileSync(file, text);
}
// Revalidate exact artifact digest at the runtime's EXISTING file-attestation
// boundary. No new production flag, semver range, HTTP rewrite or npm identity.
const gate = "agent-node/src/runtime/opencode-acp/binary.ts";
let text = readFileSync(gate, "utf8");
text = text.replace('const binaryFile = attestRegularFile(binary, "binary");',
  `const binaryFile = attestRegularFile(binary, "binary"); if (generation === "v2" && binaryFile.sha256 !== "${sha}") throw Error("test_native_sha_refused");`);
writeFileSync(gate, text);
const packageGate = "agent-network/src/opencode-package-binary.ts";
const packageText = readFileSync(packageGate, "utf8"), numericGate = '!/^\\d+\\.\\d+\\.\\d+$/.test(options.expectedVersion)';
if (!packageText.includes(numericGate)) throw Error("test_numeric_gate_overlay_drift");
writeFileSync(packageGate, packageText.replace(numericGate, `options.expectedVersion !== ${JSON.stringify(identity)}`));
const transport = "agent-node/src/runtime/session-source-transport.ts";
writeFileSync(transport, readFileSync(transport, "utf8").replace('catch { result = { error: "directory_read_failed" }; }',
  'catch (e) { console.error("NATIVE_DIRECTORY_FIRST_ERROR", e instanceof Error && /^directory_[a-z_]+$/.test(e.message) ? e.message : "redacted"); result = { error: "directory_read_failed" }; }'));
const operation = "agent-node/src/runtime/session-project-create.ts";
writeFileSync(operation, readFileSync(operation, "utf8").replace('} catch { /* Unknown is negative-only; never relaunch or delete any Session. */ }',
  '} catch (e) { console.error("NATIVE_DELIVERY_FIRST_ERROR", e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "redacted"); }')
  .replace('catch { return { status: "unknown_rotation_required" }; }',
    'catch (e) { console.error("NATIVE_OPERATION_REFUSAL", e instanceof Error && /^(?:project_attach_|source_resume_)[a-z_]+$/.test(e.message) ? e.message : "redacted"); return { status: "unknown_rotation_required" }; }'));
const launcher = "agent-node/src/runtime/source-resume-launcher.ts";
writeFileSync(launcher, readFileSync(launcher, "utf8").replace('const found = String(b).match',
  'console.error("NATIVE_CHILD_FAILURE_CATEGORY", ["source_resume_", "Expected trusted", "not inside", "version", "unsafe", "Incompatible", "Missing", "Error:"].filter(x => String(b).includes(x))); const found = String(b).match'));
// Reuse ONLY this existing one-shot identity overlay for source evidence. Wire
// api_version stays the 2.0.22 BASE contract; actual native info is never rewritten.
const evidence = "agent-node/src/runtime/session-source-evidence.ts";
writeFileSync(evidence, readFileSync(evidence, "utf8").replace('info?.version !== "2.0.22"', `info?.version !== ${JSON.stringify(identity)}`)
  .replace('catch { return { ok: false, error: "source_evidence_refused" }; }',
    'catch (e) { console.error("NATIVE_SOURCE_EVIDENCE_REFUSAL", e instanceof Error && /^source_[a-z_]+$/.test(e.message) ? e.message : "redacted"); return { ok: false, error: "source_evidence_refused" }; }')
  .replace('catch { return null; }\n      finally { sourceExecutions.delete(key); }',
    'catch (e) { console.error("NATIVE_SOURCE_DELIVERY_REFUSAL", e instanceof Error && /^source_[a-z_]+$/.test(e.message) ? e.message : "redacted"); return null; }\n      finally { sourceExecutions.delete(key); }'));
// Fixed diagnostic for the known runtime startup boundary, never arbitrary stderr.
const runtime = "agent-node/src/runtime/opencode-copresence/runtime.ts";
writeFileSync(runtime, readFileSync(runtime, "utf8").replace('OpenCode copresence requires an explicit provider/model', 'source_resume_explicit_model_required'));
// Fork must use the real native listener (OS pid/socket proof), not the earlier
// transparent HTTP proxy. Audit requests in-process without changing responses.
// This is test-copy instrumentation, not a product provenance/identity path.
if (process.env.TEST4150_NATIVE_FORK === "1" || process.env.TEST4150_NATIVE_ATTACH === "1") {
  const cli = "agent-node/src/cli.ts";
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync as test4150Append } from "node:fs";
const test4150Fetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.origin === process.env.TEST4150_NATIVE_ORIGIN && process.env.TEST4150_NATIVE_AUDIT) {
    test4150Append(process.env.TEST4150_NATIVE_AUDIT, JSON.stringify({method: init?.method ?? "GET", path: url.pathname}) + "\\n");
  }
  return test4150Fetch(input, init);
}) as typeof fetch;
` + readFileSync(cli, "utf8").replace(/^#![^\n]*\n/, ""));
}
const child = Bun.spawn([process.execPath, "test", process.env.TEST4150_NATIVE_ATTACH === "1" ? "server/src/session-project-attach-native.test.ts" : "server/src/session-project-create-native.test.ts"], {
  cwd: "/work", env: { ...process.env, TEST4150_NATIVE_BINARY: `${pkg}/bin/opencode.exe`, TEST4150_NATIVE_IDENTITY: identity },
  stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
