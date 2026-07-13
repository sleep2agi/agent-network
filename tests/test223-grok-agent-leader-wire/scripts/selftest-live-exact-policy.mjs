import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  liveBindingFor,
  loadLiveExactPolicy,
} from "../lib/live-exact-policy.mjs";

const suiteRoot = fileURLToPath(new URL("../", import.meta.url));

function requireTrue(value, message) {
  if (!value) throw new Error(message);
}

function requireClosed(run, message) {
  let closed = false;
  try {
    run();
  } catch {
    closed = true;
  }
  requireTrue(closed, message);
}

function requireClosedMatching(run, pattern, message) {
  let error;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  requireTrue(error instanceof Error && pattern.test(error.message), message);
}

const allowlist = JSON.parse(readFileSync(join(suiteRoot, "protocol-allowlist.json"), "utf8"));
const candidate = loadLiveExactPolicy({
  suiteRoot,
  protocolAllowlist: allowlist,
  mode: "candidate",
});
requireTrue(candidate.mode === "candidate"
  && candidate.status === "pending_selector_scoped_scrub_only"
  && /^[0-9a-f]{64}$/.test(candidate.selectorSeedSha256)
  && candidate.acceptedIndexSha256 === null
  && candidate.acceptedShapesSha256 === null,
"candidate policy did not remain review-pending");
requireTrue(liveBindingFor(candidate, "leader-native-tui", "leader-native-tui").scopeId
  === "phase0/leader-native-tui",
"candidate capture did not resolve its exact source binding");
requireClosed(
  () => liveBindingFor(candidate, "leader-native-tui", "live-approval-owner-matrix"),
  "cross-capture candidate binding stayed open",
);

const temp = mkdtempSync(join(tmpdir(), "test223-live-exact-policy-"));
try {
  requireClosedMatching(() => loadLiveExactPolicy({
    suiteRoot: temp,
    protocolAllowlist: allowlist,
    mode: "accepted",
  }), /accepted_live_exact_attestation_required/,
  "accepted mode did not close without a protected v3 attestation");
  requireClosedMatching(() => loadLiveExactPolicy({
    suiteRoot: temp,
    protocolAllowlist: allowlist,
    mode: "accepted",
    expectedAcceptedIndexSha256: "a".repeat(64),
    expectedAcceptedShapesSha256: "b".repeat(64),
  }), /accepted_live_exact_attestation_required/,
  "legacy digest parameters reopened accepted mode");

  const candidateTemp = join(temp, "candidate-suite");
  cpSync(suiteRoot, candidateTemp, { recursive: true });
  const mutatedAllowlist = JSON.parse(readFileSync(join(candidateTemp,
    "protocol-allowlist.json"), "utf8"));
  const methodSelector = mutatedAllowlist.candidateLiveExactShapePolicy.selectors
    .find((entry) => typeof entry.selector?.method === "string");
  methodSelector.selector.method = "<METHOD_1>";
  writeFileSync(join(candidateTemp, "protocol-allowlist.json"),
    `${JSON.stringify(mutatedAllowlist, null, 2)}\n`);
  requireClosedMatching(() => loadLiveExactPolicy({
    suiteRoot: candidateTemp,
    protocolAllowlist: mutatedAllowlist,
    mode: "candidate",
  }), /unreviewed protocol literal/,
  "generic method placeholder did not reach the candidate literal gate");

  process.stdout.write("PASS: live exact policy trust-root self-test\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
