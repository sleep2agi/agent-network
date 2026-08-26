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
  requireContract(!/^\s+ref:/m.test(w), "credential checkout accepts an alternate ref");
  requireContract(/GITHUB_REF[^\n]+refs\/heads\/main/.test(w), "trusted-main assertion missing");
  requireContract(/select\(\.type == "required_reviewers"\)/.test(w), "required reviewer check weakened");
  for (const match of w.matchAll(/uses:\s+\S+@([^\s]+)/g)) requireContract(/^[0-9a-f]{40}$/.test(match[1]), "an action is not commit-SHA pinned");
  const removeSecret = r.indexOf("Remove-Item Env:ANET_CODEX_AUTH_JSON");
  const npmInstall = r.indexOf("npm install --prefix");
  const writeAuth = r.indexOf("[IO.File]::WriteAllText");
  requireContract(removeSecret >= 0 && removeSecret < npmInstall && npmInstall < writeAuth, "credential crosses package-install boundary");
  requireContract(/Codex executable hash is outside trusted allowlist/.test(r), "binary allowlist is not fail-closed");
  const allowlistGate = r.indexOf("Codex executable hash is outside trusted allowlist");
  requireContract(r.indexOf("& $codexCmd") > allowlistGate, "Codex executed before allowlist gate");
  requireContract(!/Get-ChildItem[^\n]+-Recurse|Select-Object -First/i.test(r), "vendor resolution accepts a recursive decoy");
  requireContract(/thread\/read/.test(j) && /status !== "inProgress"/.test(j) && /status !== "completed"/.test(j), "authoritative active/completed turn boundary missing");
  requireContract(!/output\.match\(new RegExp\(marker/.test(j), "ConPTY redraw is treated as HUMAN_DONE evidence");
  requireContract(/steered !== 2/.test(j) && /role === "bridge"/.test(j), "same-turn/single-bridge assertions missing");
}
audit(workflow, runner, journey);
audit(workflow.replaceAll("\n", "\r\n"), runner.replaceAll("\n", "\r\n"), journey.replaceAll("\n", "\r\n"));
function replaceRequired(source, needle, replacement, name) {
  requireContract(source.includes(needle), `mutation target absent: ${name}`);
  const changed = source.replaceAll(needle, replacement);
  requireContract(changed !== source, `mutation made no change: ${name}`);
  return changed;
}
const mutations = [
  ["PR trigger", `pull_request_target:\n${workflow}`, runner, journey],
  // Appending a YAML ref key is deliberately line-ending agnostic. The audit
  // rejects caller-controlled refs anywhere in this single-purpose workflow.
  ["candidate checkout", `${workflow}\n      ref: candidate-head\n`, runner, journey],
  ["weak environment", replaceRequired(workflow, 'select(.type == "required_reviewers")', 'select(.type == "wait_timer")', "weak environment"), runner, journey],
  ["secret during npm", workflow, replaceRequired(runner, "Remove-Item Env:ANET_CODEX_AUTH_JSON", "# removed", "secret during npm"), journey],
  ["prehash execution", workflow, replaceRequired(runner, "$codexInstall =", "& $codexCmd --version\n  $codexInstall =", "prehash execution"), journey],
  ["vendor decoy", workflow, replaceRequired(runner, "$vendorPath =", "Get-ChildItem $codexInstall -Recurse | Select-Object -First 1\n  $vendorPath =", "vendor decoy"), journey],
  ["ConPTY redraw nonce", workflow, runner, replaceRequired(journey, "if (!injected", "if ((output.match(new RegExp(marker, 'g')) || []).length >= 2) activeTurnId = 'redraw';\n    if (!injected", "ConPTY redraw nonce")],
  ["no authoritative read", workflow, runner, replaceRequired(journey, "thread/read", "screen/read", "no authoritative read")],
];
for (const [name, w, r, j] of mutations) {
  requireContract(w !== workflow || r !== runner || j !== journey, `mutation made no target change: ${name}`);
  let red = false;
  try { audit(w, r, j); } catch { red = true; }
  requireContract(red, `weakening mutation stayed green: ${name}`);
}
console.log(`PASS test1212 trusted-main LF+CRLF baselines + ${mutations.length} weakening mutations red`);
