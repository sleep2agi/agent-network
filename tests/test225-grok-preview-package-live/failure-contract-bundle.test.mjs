import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBuiltAgentNodeBundle } from "./failure-contract.mjs";

const bundlePath = process.env.TEST225_AGENT_NODE_BUNDLE;
assert.ok(bundlePath, "TEST225_AGENT_NODE_BUNDLE is required");
const bundle = readFileSync(bundlePath, "utf8");

const FAILURE_CODES_JSON = JSON.stringify([
  "approval_boundary", "correlation", "input_validation", "jsonl_tail",
  "leader_lifecycle", "native_outcome", "runtime_closed", "service_or_model",
  "spawn_audit", "timeout", "tui_exit", "unknown",
]);
const FAILURE_SUBCODES_JSON = JSON.stringify([
  "unknown", "chat.stat.missing_after_arm", "chat.stat.identity_changed",
  "chat.stat.size_regressed", "chat.stat.non_regular", "chat.stat.owner_mismatch",
  "chat.stat.io_other", "chat.open.io_other", "chat.fstat.non_regular",
  "chat.fstat.io_other", "chat.read.io_other", "chat.read.state_invariant",
  "chat.close.io_other", "chat.reduce.state_invariant",
  "events.stat.missing_after_arm", "events.stat.identity_changed",
  "events.stat.size_regressed", "events.stat.non_regular", "events.stat.owner_mismatch",
  "events.stat.io_other", "events.open.io_other", "events.fstat.non_regular",
  "events.fstat.io_other", "events.read.io_other", "events.read.state_invariant",
  "events.close.io_other", "events.reduce.state_invariant",
  "events.lifecycle.state_invariant", "combined.flush.state_invariant",
]);

const identifier = "([A-Za-z_$][\\w$]*)";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function reviewedSetNames(source) {
  const runtimeCodes = new RegExp(
    `${identifier}=${escapeRegex(FAILURE_CODES_JSON)},${identifier}=new Set\\(\\1\\)`,
  ).exec(source);
  const runtimeSubcodes = new RegExp(
    `${identifier}=Object\\.freeze\\(${escapeRegex(FAILURE_SUBCODES_JSON)}\\),${identifier}=new Set\\(\\1\\)`,
  ).exec(source);
  const cliCodes = new RegExp(
    `${identifier}=new Set\\(${escapeRegex(FAILURE_CODES_JSON)}\\)`,
  ).exec(source);
  const cliSubcodes = new RegExp(
    `${identifier}=new Set\\(${escapeRegex(FAILURE_SUBCODES_JSON)}\\)`,
  ).exec(source);
  assert.ok(runtimeCodes && runtimeSubcodes && cliCodes && cliSubcodes,
    "packed reviewed set bindings must be present before mutation");
  // Minified identifiers can contain `$`; these values are inserted into regexes.
  return {
    runtimeCodes: escapeRegex(runtimeCodes[2]),
    runtimeSubcodes: escapeRegex(runtimeSubcodes[2]),
    cliCodes: escapeRegex(cliCodes[1]),
    cliSubcodes: escapeRegex(cliSubcodes[1]),
  };
}

test("accepts the packed agent-node failure review boundaries", () => {
  assert.doesNotThrow(() => validateBuiltAgentNodeBundle(bundle));
});

test("rejects packed semantic and boundary mutations", () => {
  const sets = reviewedSetNames(bundle);
  const mutations = [
    ["runtime failure-code membership", bundle.replace(
      new RegExp(`function ${identifier}\\(${identifier}\\)\\{return typeof \\2==="string"&&${sets.runtimeCodes}\\.has\\(\\2\\)\\}`),
      (match) => match.replace("&&", "&&true&&"),
    )],
    ["runtime failure-subcode membership", bundle.replace(
      new RegExp(`function ${identifier}\\(${identifier}\\)\\{return typeof \\2==="string"&&${sets.runtimeSubcodes}\\.has\\(\\2\\)\\?\\2:"unknown"\\}`),
      (match) => match.replace("?", '?"unreviewed"||'),
    )],
    ["CLI failure-code membership", bundle.replace(
      new RegExp(`return typeof (${identifier})==="string"&&${sets.cliCodes}\\.has\\(\\1\\)\\?\\1:null`),
      (match) => match.replace("&&", "&&true&&"),
    )],
    ["CLI failure-subcode membership", bundle.replace(
      new RegExp(`==="jsonl_tail"\\)return\\{code:[A-Za-z_$][\\w$]*,subcode:typeof ([A-Za-z_$][\\w$]*)==="string"&&${sets.cliSubcodes}\\.has\\(\\1\\)\\?\\1:"unknown"\\}`),
      (match) => match.replace("subcode:typeof ", 'subcode:"unreviewed"||typeof '),
    )],
    ["failure marker", bundle.replace("[grok_failure:${", "[grok_unreviewed:${")],
    ["reviewed subcode literal boundary", bundle.replace("Object.freeze([\"unknown\",\"chat.stat.missing_after_arm\"", "Object.freeze([\"unknown\",\"chat.stat.unreviewed\",\"chat.stat.missing_after_arm\"")],
  ];
  for (const [label, mutated] of mutations) {
    assert.ok(mutated !== bundle, `${label}: mutation did not alter the real packed bundle`);
    assert.throws(() => validateBuiltAgentNodeBundle(mutated), `${label}: mutated boundary was accepted`);
  }
});
