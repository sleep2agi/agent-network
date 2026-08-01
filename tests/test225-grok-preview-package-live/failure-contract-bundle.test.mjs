import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBuiltAgentNodeBundle } from "./failure-contract.mjs";

const bundlePath = process.env.TEST225_AGENT_NODE_BUNDLE;
assert.ok(bundlePath, "TEST225_AGENT_NODE_BUNDLE is required");
const bundle = readFileSync(bundlePath, "utf8");

test("accepts the packed agent-node failure review boundaries", () => {
  assert.doesNotThrow(() => validateBuiltAgentNodeBundle(bundle));
});

test("rejects packed semantic and boundary mutations", () => {
  const mutations = [
    bundle.replace(
      /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return typeof \2==="string"&&([A-Za-z_$][\w$]*)\.has\(\2\)\}/,
      (match) => match.replace("&&", "&&true&&"),
    ),
    bundle.replace(
      /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return typeof \2==="string"&&([A-Za-z_$][\w$]*)\.has\(\2\)\?\2:"unknown"\}/,
      (match) => match.replace("?", '?"unreviewed"||'),
    ),
    bundle.replace(
      /return typeof ([A-Za-z_$][\w$]*)==="string"&&([A-Za-z_$][\w$]*)\.has\(\1\)\?\1:null/,
      (match) => match.replace("&&", "&&true&&"),
    ),
    bundle.replace(
      /==="jsonl_tail"\)return\{code:[A-Za-z_$][\w$]*,subcode:typeof [A-Za-z_$][\w$]*==="string"&&[A-Za-z_$][\w$]*\.has\([A-Za-z_$][\w$]*\)\?[A-Za-z_$][\w$]*:"unknown"\}/,
      (match) => match.replace("subcode:typeof ", 'subcode:"unreviewed"||typeof '),
    ),
    bundle.replace("[grok_failure:${", "[grok_unreviewed:${"),
    bundle.replace("Object.freeze([\"unknown\",\"chat.stat.missing_after_arm\"", "Object.freeze([\"unknown\",\"chat.stat.unreviewed\",\"chat.stat.missing_after_arm\""),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, bundle, "mutation did not alter the real packed bundle");
    assert.throws(() => validateBuiltAgentNodeBundle(mutated));
  }
});
