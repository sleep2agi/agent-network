import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assistantSnapshot, newHumanDoneAssistant, pollCompletedAssistant } from "./thread-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/windows-real-codex-gate.yml"), "utf8");
const runner = readFileSync(resolve(import.meta.dirname, "run.ps1"), "utf8");
const journey = readFileSync(resolve(import.meta.dirname, "windows-real-e2e.mjs"), "utf8");
const evidence = readFileSync(resolve(import.meta.dirname, "thread-evidence.mjs"), "utf8");
function requireContract(value, message) { if (!value) throw new Error(message); }
function audit(w, r, j, e) {
  requireContract(!/^\s*pull_request(?:_target)?:/m.test(w), "credential workflow gained a PR trigger");
  requireContract(/workflow_dispatch:/.test(w) && !/^\s+ref:/m.test(w), "trusted checkout weakened");
  requireContract(/GITHUB_REF[^\n]+refs\/heads\/main/.test(w), "trusted-main assertion missing");
  requireContract(/select\(\.type == "required_reviewers"\)/.test(w), "required reviewer check weakened");
  for (const match of w.matchAll(/uses:\s+\S+@([^\s]+)/g)) requireContract(/^[0-9a-f]{40}$/.test(match[1]), "action not SHA pinned");
  const removeSecret = r.indexOf("Remove-Item Env:ANET_CODEX_AUTH_JSON"), npmInstall = r.indexOf("npm install --prefix"), writeAuth = r.indexOf("[IO.File]::WriteAllText"), gate = r.indexOf("Codex executable hash is outside trusted allowlist");
  requireContract(removeSecret >= 0 && removeSecret < npmInstall && npmInstall < writeAuth, "credential crosses npm boundary");
  requireContract(gate >= 0 && r.indexOf("& $codexCmd") > gate, "Codex executed before allowlist");
  requireContract(r.includes("(?:%~dp0|%dp0%)"), "current npm cmd-shim canonical launcher form unsupported");
  requireContract(!/Get-ChildItem[^\n]+-Recurse|Select-Object -First/i.test(r), "vendor decoy accepted");
  requireContract(/thread\/read/.test(j) && /pollCompletedAssistant/.test(j), "authoritative bounded read missing");
  requireContract(!/output\.match\(new RegExp\(marker/.test(j), "ConPTY redraw accepted");
  requireContract(/steered !== 2/.test(j) && /role === "bridge"/.test(j), "same-turn/single-bridge missing");
  requireContract(/ASSISTANT_TYPES\.has\(normalizedType\(item\)\)/.test(e), "assistant type filter missing");
}
audit(workflow, runner, journey, evidence);
audit(...[workflow, runner, journey, evidence].map(text => text.replaceAll("\n", "\r\n")));
function replaceRequired(source, needle, replacement, name) { requireContract(source.includes(needle), `mutation target absent: ${name}`); const changed = source.replaceAll(needle, replacement); requireContract(changed !== source, `mutation no-op: ${name}`); return changed; }
const mutations = [
  ["PR trigger", `pull_request_target:\n${workflow}`, runner, journey, evidence],
  ["candidate checkout", `${workflow}\n      ref: candidate-head\n`, runner, journey, evidence],
  ["weak environment", replaceRequired(workflow, 'select(.type == "required_reviewers")', 'select(.type == "wait_timer")', "environment"), runner, journey, evidence],
  ["secret during npm", workflow, replaceRequired(runner, "Remove-Item Env:ANET_CODEX_AUTH_JSON", "# removed", "secret"), journey, evidence],
  ["prehash execution", workflow, replaceRequired(runner, "$codexInstall =", "& $codexCmd --version\n  $codexInstall =", "prehash"), journey, evidence],
  ["new cmd-shim form", workflow, replaceRequired(runner, "(?:%~dp0|%dp0%)", "%~dp0", "cmd-shim"), journey, evidence],
  ["vendor decoy", workflow, replaceRequired(runner, "$vendorPath =", "Get-ChildItem $codexInstall -Recurse | Select-Object -First 1\n  $vendorPath =", "decoy"), journey, evidence],
  ["ConPTY redraw", workflow, runner, replaceRequired(journey, "if (!injected", "if ((output.match(new RegExp(marker, 'g')) || []).length >= 2) activeTurnId='redraw';\n if (!injected", "redraw"), evidence],
  ["no authoritative read", workflow, runner, replaceRequired(journey, "thread/read", "screen/read", "read"), evidence],
  ["no assistant filter", workflow, runner, journey, replaceRequired(evidence, ".filter(item => ASSISTANT_TYPES.has(normalizedType(item)))", ".filter(item => true)", "assistant filter")],
];
for (const [name, w, r, j, e] of mutations) { requireContract(w !== workflow || r !== runner || j !== journey || e !== evidence, `mutation unchanged: ${name}`); let red = false; try { audit(w, r, j, e); } catch { red = true; } requireContract(red, `mutation stayed green: ${name}`); }

const nonce = "NONCE_A";
const before = assistantSnapshot({ items: [{ id: "a0", type: "agentMessage", text: "earlier" }] });
const promptOnly = { id: "t", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: `${nonce} HUMAN_DONE` }] }] };
requireContract(!newHumanDoneAssistant(promptOnly, before, nonce), "user prompt satisfied assistant proof");
let reads = 0;
const late = await pollCompletedAssistant(async () => ({ turns: [reads++ < 2 ? promptOnly : { ...promptOnly, items: [...promptOnly.items, { id: "a1", type: "agentMessage", text: `${nonce} HUMAN_DONE` }] }] }), "t", before, nonce, { timeoutMs: 1000, intervalMs: 1 });
requireContract(late.item.id === "a1" && reads === 3, "bounded poll did not wait for late assistant");
console.log(`PASS test1212 LF+CRLF + prompt-only red + late-assistant green + ${mutations.length} mutations red`);
