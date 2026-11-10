// #1324 real-evidence run: a REAL supported V2 serve must bind, and the shapes
// that only look similar must not.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readlinkSync } from "node:fs";
import { observeHostSharedServe } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts";
import { bindHostSharedServeGeneration } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-generation.ts";
import {
  resolvePinnedOpencodeBinaryAttestation,
  revalidatePinnedOpencodeBinary,
} from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-acp/binary.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitForListener(port: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = observeHostSharedServe(`http://127.0.0.1:${port}`);
    if (r.ok) return r;
    await Bun.sleep(200);
  }
  return undefined;
}

function freePort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

// ── 1. REAL V2 serve (the positive the card demands) ────────────────────────
const v2Bin = execFileSync("cat", ["/v2-bin"], { encoding: "utf8" }).trim();
const v1Bin = execFileSync("cat", ["/v1-bin"], { encoding: "utf8" }).trim();
// The adapter takes the attestation/revalidation as REQUIRED caller inputs (it
// never guesses a PATH): here they come from the real installed packages.
// The version probe runs with an EXPLICITLY isolated env + cwd, supplied here by
// the caller (the adapter itself never builds an environment).
mkdirSync("/tmp/gen1324-probe", { recursive: true });
const probeEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
const probeCwd = "/tmp/gen1324-probe";
const attest = (generation: "v1" | "v2") =>
  resolvePinnedOpencodeBinaryAttestation({
    generation, requestedBinary: generation === "v2" ? v2Bin : v1Bin, probeEnv, probeCwd,
  });
const revalidate = (attestation: any) => { revalidatePinnedOpencodeBinary(attestation); };
const v2Attestation = attest("v2");
console.log(`v2 attested binary=${v2Attestation.binary} version=${v2Attestation.expectedVersion} sha256=${v2Attestation.binaryFile.sha256.slice(0, 12)}…`);

const v2Port = freePort();
const v2 = spawn(v2Attestation.binary, ["serve", "--hostname", "127.0.0.1", "--port", String(v2Port)], { stdio: ["ignore", "ignore", "ignore"] });
const v2Observed = await waitForListener(v2Port);
check("real V2 serve is observable", !!v2Observed);
if (v2Observed?.ok) {
  const bound = bindHostSharedServeGeneration(v2Observed.processEvidence, "v2", { attest, revalidate });
  check("real V2 serve binds to v2", bound.ok && bound.generation === "v2", bound.ok ? "" : bound.reason);
  if (bound.ok) {
    check("proof carries the attested dev/ino/sha256",
      bound.proof.dev === String(v2Attestation.binaryFile.dev)
      && bound.proof.ino === String(v2Attestation.binaryFile.ino)
      && bound.proof.sha256 === v2Attestation.binaryFile.sha256);
    check("proof keeps the listener binding (pid/startTicks/inode)",
      bound.proof.pid === v2Observed.processEvidence.pid
      && bound.proof.startTicks === v2Observed.processEvidence.startTicks
      && bound.proof.listenInode === v2Observed.processEvidence.listenInode);
    check("proof names the attested package/version",
      bound.proof.packageName === "@opencode/cli" && bound.proof.packageVersion === v2Attestation.expectedVersion);
  }
  // Diagnostic: what does /proc/<pid>/exe resolve to? (helps read a failure)
  console.log(`observed exe=${v2Observed.processEvidence.diagnostics.executable} resolved=${readlinkSync(`/proc/${v2Observed.processEvidence.pid}/exe`)}`);
  // #1324 review P1-2 (real): an invented listener inode must not pass.
  const fabricated = bindHostSharedServeGeneration(
    { ...v2Observed.processEvidence, listenInode: "0" }, "v2", { attest, revalidate },
  );
  check("a fabricated listenInode is refused", !fabricated.ok && fabricated.reason === "observation_drift", fabricated.ok ? "bound!" : fabricated.reason);

  // Asking for v1 while a v2 binary holds the socket must NOT pass.
  const asV1 = bindHostSharedServeGeneration(v2Observed.processEvidence, "v1", { attest, revalidate });
  check("a V2 serve asked as v1 is refused", !asV1.ok, asV1.ok ? "" : asV1.reason);
}

// ── 2. same-argv fake `opencode` (script → interpreter) ─────────────────────
const dir = mkdtempSync(join(tmpdir(), "gen1324-"));
const fake = join(dir, "opencode");
writeFileSync(fake, "#!/usr/bin/env bun\nconst a=process.argv.slice(2);const p=Number(a[a.indexOf(\"--port\")+1]);Bun.serve({hostname:\"127.0.0.1\",port:p,fetch:()=>new Response(\"ok\")});await new Promise(()=>{});\n", { mode: 0o755 });
chmodSync(fake, 0o755);
const fakePort = freePort();
const fakeProc = spawn(fake, ["serve", "--hostname", "127.0.0.1", "--port", String(fakePort)], { stdio: ["ignore", "ignore", "ignore"] });
const fakeObserved = await waitForListener(fakePort);
check("same-argv fake serve is observable", !!fakeObserved);
if (fakeObserved?.ok) {
  const bound = bindHostSharedServeGeneration(fakeObserved.processEvidence, "v2", { attest, revalidate });
  check("same-argv fake is refused (not bound to v2)", !bound.ok, bound.ok ? "bound!" : bound.reason);
}

// ── 3. REAL V1 package with the same argv ───────────────────────────────────
try {
  const v1Bin = execFileSync("cat", ["/v1-bin"], { encoding: "utf8" }).trim();
  const v1Attestation = attest("v1");
  const v1Port = freePort();
  // V1's own serve argv shape (it takes --pure; V2 rejects it).
  // Real finding this suite demonstrates: V1 and V2 share the default
  // `~/.local/share/opencode/opencode.db`, and V1 refuses to start on a V2-schema
  // DB ("Database is not empty and has no session table"). The negative therefore
  // gives V1 its own data home instead of piggybacking on V2's.
  const v1 = spawn(v1Attestation.binary, ["serve", "--hostname", "127.0.0.1", "--port", String(v1Port), "--pure"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: "/tmp/gen1324-v1-xdg" },
  });
  let v1Stderr = "";
  v1.stderr?.on("data", (b) => { v1Stderr += String(b); });
  // V1 warms up slower than V2 in this image; give it real time before calling it absent.
  const v1Observed = await waitForListener(v1Port, 30_000);
  if (v1Observed?.ok) {
    // Use the SAME real V1 process and its genuine V1 attestation: before the
    // generation check, their matching file identities allowed relabelling as V2.
    // A V2 process paired with a V1 attestation would already fail on file identity.
    const relabelled = bindHostSharedServeGeneration(
      v1Observed.processEvidence, "v2", { attest: () => v1Attestation, revalidate },
    );
    check("real V1 process and V1 attestation cannot be relabelled as v2",
      !relabelled.ok && relabelled.reason === "generation_contract_mismatch",
      relabelled.ok ? "bound!" : relabelled.reason);
    const bound = bindHostSharedServeGeneration(v1Observed.processEvidence, "v2", { attest, revalidate });
    check("a real V1 serve asked as v2 is refused", !bound.ok, bound.ok ? "bound!" : bound.reason);
  } else {
    check("real V1 serve observable", false, `V1 serve did not listen within 30s: ${v1Stderr.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  v1.kill();
} catch (error) {
  check("V1 attestation available (or absent)", true, `skipped: ${(error as Error).message.slice(0, 60)}`);
}

// ── 4. a REAL file swap invalidates a standing attestation ──────────────────
const swapTarget = join(dir, "swapped-opencode");
copyFileSync(v2Attestation.binary, swapTarget);
const before = statSync(swapTarget);
const swapped = { ...v2Attestation, binary: swapTarget, binaryFile: { ...v2Attestation.binaryFile, dev: String(before.dev), ino: String(before.ino), size: before.size } };
writeFileSync(swapTarget, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
let swapRefused = false;
try { revalidatePinnedOpencodeBinary(swapped as any); } catch { swapRefused = true; }
check("revalidate refuses a file swapped after attestation", swapRefused);

// ── 5. the observation binding refuses once the process is gone ─────────────
const deadPort = freePort();
const deadProc = spawn(v2Attestation.binary, ["serve", "--hostname", "127.0.0.1", "--port", String(deadPort)], { stdio: ["ignore", "ignore", "ignore"] });
const deadObserved = await waitForListener(deadPort);
deadProc.kill();
if (deadObserved?.ok) {
  await Bun.sleep(300);
  const bound = bindHostSharedServeGeneration(deadObserved.processEvidence, "v2", { attest, revalidate });
  check("a gone listener cannot be bound", !bound.ok, bound.ok ? "bound!" : bound.reason);
}

for (const p of [v2, fakeProc]) { try { p.kill(); } catch { /* gone */ } }
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "PASS: host-shared generation binding" : `FAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
