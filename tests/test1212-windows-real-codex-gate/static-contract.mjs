import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/windows-real-codex-gate.yml"), "utf8");
const runner = readFileSync(resolve(import.meta.dirname, "run.ps1"), "utf8");
const journey = readFileSync(resolve(import.meta.dirname, "windows-real-e2e.mjs"), "utf8");
function requireContract(value, message) { if (!value) throw new Error(message); }
function audit(w, r, j) {
  requireContract(!/^\s*pull_request(?:_target)?:/m.test(w), "credential workflow gained a PR trigger");
  requireContract(/workflow_dispatch:/.test(w), "manual main trigger missing");
  requireContract(!/checkout[^\n]*\n(?:.|\n){0,160}\bref:/m.test(w), "credential checkout accepts an alternate ref");
  requireContract(/GITHUB_REF[^\n]+refs\/heads\/main/.test(w), "trusted-main assertion missing");
  requireContract(/select\(\.type == "required_reviewers"\)/.test(w), "required reviewer check weakened");
  for (const match of w.matchAll(/uses:\s+\S+@([^\s]+)/g)) requireContract(/^[0-9a-f]{40}$/.test(match[1]), "an action is not commit-SHA pinned");
  const removeSecret = r.indexOf("Remove-Item Env:ANET_CODEX_AUTH_JSON");
  const npmInstall = r.indexOf("npm install --prefix");
  const writeAuth = r.indexOf("[IO.File]::WriteAllText");
  requireContract(removeSecret >= 0 && removeSecret < npmInstall && npmInstall < writeAuth, "credential crosses package-install boundary");
  requireContract(/Codex executable hash is outside trusted allowlist/.test(r), "binary allowlist is not fail-closed");
  requireContract(/length >= 2/.test(j) && /humanDoneAt - injectionAt < 60000/.test(j), "HUMAN_DONE active-turn timing proof missing");
  requireContract(/steered !== 2/.test(j) && /role === "bridge"/.test(j), "same-turn/single-bridge assertions missing");
}
audit(workflow, runner, journey);
const mutations = [
  ["PR trigger", `pull_request_target:\n${workflow}`, runner, journey],
  ["candidate checkout", workflow.replace("persist-credentials: false", "ref: ${{ inputs.source_sha }}\n          persist-credentials: false"), runner, journey],
  ["weak environment", workflow.replace('select(.type == "required_reviewers")', 'select(.type == "wait_timer")'), runner, journey],
  ["secret during npm", workflow, runner.replace("Remove-Item Env:ANET_CODEX_AUTH_JSON", "# removed"), journey],
  ["short human turn", workflow, runner, journey.replace("humanDoneAt - injectionAt < 60000", "humanDoneAt - injectionAt < 1")],
];
for (const [name, w, r, j] of mutations) {
  let red = false;
  try { audit(w, r, j); } catch { red = true; }
  requireContract(red, `weakening mutation stayed green: ${name}`);
}
console.log(`PASS test1212 trusted-main contract + ${mutations.length} weakening mutations red`);
