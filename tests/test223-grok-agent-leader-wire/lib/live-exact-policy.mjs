import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GROK_WIRE_BASELINE,
  isExactGrokWireBaseline,
} from "./grok-wire-baseline.mjs";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonicalSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(stable(value))));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields differ from reviewed schema`);
  }
}

function hasGenericProtocolPlaceholder(value) {
  return typeof value === "string"
    && (/^<[A-Z][A-Z0-9_]*_\d+>$/.test(value) || value === "unresolved");
}

function validateCandidatePolicy(policy, protocolAllowlist) {
  const methods = new Set(protocolAllowlist.methods || []);
  const selectorKeys = new Set();
  for (const [entryIndex, entry] of policy.selectors.entries()) {
    exactKeys(entry, ["selector", "shapes"], `candidate selector ${entryIndex}`);
    const selectorFields = entry.selector?.messageKind === "outer-message"
      ? ["transport", "outerType", "messageKind"]
      : ["transport", "outerType", "messageKind", "method"];
    exactKeys(entry.selector, selectorFields, `candidate selector ${entryIndex}.selector`);
    if (hasGenericProtocolPlaceholder(entry.selector.outerType)
      || hasGenericProtocolPlaceholder(entry.selector.method)
      || (entry.selector.method !== undefined && !methods.has(entry.selector.method))) {
      throw new Error("candidate selector contains an unreviewed protocol literal");
    }
    const selectorKey = JSON.stringify(stable(entry.selector));
    if (selectorKeys.has(selectorKey) || !Array.isArray(entry.shapes) || entry.shapes.length === 0) {
      throw new Error("candidate selector is duplicated or empty");
    }
    selectorKeys.add(selectorKey);
    const shapeKeys = new Set();
    for (const shape of entry.shapes) {
      exactKeys(shape, ["paths", "enums"], "candidate shape");
      if (!Array.isArray(shape.paths) || shape.paths.length === 0 || !Array.isArray(shape.enums)) {
        throw new Error("candidate shape is incomplete");
      }
      for (const exact of shape.enums) {
        exactKeys(exact, ["path", "values"], "candidate exact scalar");
        if (typeof exact.path !== "string" || !Array.isArray(exact.values)
          || exact.values.length === 0
          || exact.values.some((value) => hasGenericProtocolPlaceholder(value))) {
          throw new Error("candidate exact scalar contains an unreviewed protocol literal");
        }
      }
      const shapeKey = JSON.stringify(stable(shape));
      if (shapeKeys.has(shapeKey)) throw new Error("candidate shape is duplicated");
      shapeKeys.add(shapeKey);
    }
  }
}

function loadCandidateSelectorSeeds({ suiteRoot, protocolAllowlist, policy }) {
  const binding = protocolAllowlist.candidateLiveSelectorSeed;
  exactKeys(binding, [
    "schema", "path", "sha256", "purpose", "independentAcceptance",
  ], "candidate selector seed binding");
  if (binding.schema !== "test223-candidate-live-selector-seed-binding/v1"
    || binding.path !== "candidate-live-selector-seeds.json"
    || !/^[0-9a-f]{64}$/.test(binding.sha256 || "")
    || binding.purpose !== "scrubbed-candidate-persistence-only"
    || binding.independentAcceptance !== false) {
    throw new Error("candidate selector seed binding is unsupported");
  }
  const bytes = readFileSync(join(suiteRoot, binding.path));
  if (sha256Bytes(bytes) !== binding.sha256) {
    throw new Error("candidate selector seed differs from protocol binding");
  }
  const seed = JSON.parse(bytes.toString("utf8"));
  exactKeys(seed, [
    "schema", "status", "authorizesPersistence", "authorizesExactShapeAcceptance",
    "source", "namespace", "candidateBindingSetSha256", "candidatePolicySha256", "fixtures",
  ], "candidate selector seed");
  if (seed.schema !== "test223-candidate-live-selector-seeds/v1"
    || seed.status !== "pending-independent-fixture-acceptance"
    || seed.authorizesPersistence !== false
    || seed.authorizesExactShapeAcceptance !== false
    || seed.source !== "stale-projection-selector-only"
    || !isExactGrokWireBaseline(seed.namespace)
    || seed.candidateBindingSetSha256
      !== canonicalSha256(protocolAllowlist.candidateLiveCaptureBindings)
    || seed.candidatePolicySha256 !== canonicalSha256(policy)
    || !Array.isArray(seed.fixtures)) {
    throw new Error("candidate selector seed is not bound to the pending policy");
  }
  const byScope = new Map();
  for (const fixture of seed.fixtures) {
    exactKeys(fixture, [
      "scopeId", "fixtureStem", "capture", "projectionFile", "projectionSha256",
      "completeFrameCount", "allowedSelectorSha256",
    ], "candidate selector seed fixture");
    if (!/^phase0\/[a-z0-9-]+$/.test(fixture.scopeId || "")
      || !/^[a-z0-9-]+$/.test(fixture.fixtureStem || "")
      || typeof fixture.capture !== "string"
      || fixture.projectionFile !== `${fixture.fixtureStem}.projection.ndjson`
      || !/^[0-9a-f]{64}$/.test(fixture.projectionSha256 || "")
      || !Number.isSafeInteger(fixture.completeFrameCount)
      || fixture.completeFrameCount <= 0
      || !Array.isArray(fixture.allowedSelectorSha256)
      || fixture.allowedSelectorSha256.length === 0
      || fixture.allowedSelectorSha256.some((value) => !/^[0-9a-f]{64}$/.test(value))
      || JSON.stringify(fixture.allowedSelectorSha256)
        !== JSON.stringify([...new Set(fixture.allowedSelectorSha256)].sort())
      || byScope.has(fixture.scopeId)) {
      throw new Error("candidate selector seed fixture is malformed");
    }
    byScope.set(fixture.scopeId, fixture);
  }
  return { seed, seedSha256: binding.sha256, byScope };
}

export function candidateSelectorSha256(selector) {
  return canonicalSha256({ namespace: GROK_WIRE_BASELINE, selector });
}

function validateCandidateBindings(bindings, suiteRoot) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error("candidate live capture bindings are missing");
  }
  const scopes = new Set();
  const captures = new Set();
  const stems = new Set();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object"
      || !/^phase0\/[a-z0-9-]+$/.test(binding.scopeId || "")
      || !/^[a-z0-9-]+$/.test(binding.fixtureStem || "")
      || typeof binding.capture !== "string"
      || !/^scripts\/[a-z0-9-]+\.mjs$/.test(binding.captureScript || "")
      || !/^[0-9a-f]{64}$/.test(binding.captureScriptSha256 || "")) {
      throw new Error("candidate live capture binding is malformed");
    }
    if (scopes.has(binding.scopeId)
      || captures.has(binding.capture)
      || stems.has(binding.fixtureStem)) {
      throw new Error("candidate live capture binding is duplicated");
    }
    scopes.add(binding.scopeId);
    captures.add(binding.capture);
    stems.add(binding.fixtureStem);
    const actual = sha256Bytes(readFileSync(join(suiteRoot, binding.captureScript)));
    if (actual !== binding.captureScriptSha256) {
      throw new Error(`candidate capture source hash mismatch: ${binding.fixtureStem}`);
    }
  }
  return bindings;
}

export function loadLiveExactPolicy({
  suiteRoot,
  protocolAllowlist,
  mode = process.env.TEST223_LIVE_EXACT_MODE || "candidate",
}) {
  if (mode === "candidate") {
    const policy = protocolAllowlist.candidateLiveExactShapePolicy;
    if (policy?.schema !== "test223-live-exact-candidate/v1"
      || policy.source !== "capture-scoped-pending-independent-review"
      || !Array.isArray(policy.opaqueSubtreeKeys)
      || !Array.isArray(policy.opaqueStructuralKeys)
      || !Array.isArray(policy.selectors)) {
      throw new Error("candidate live exact policy is incomplete");
    }
    validateCandidatePolicy(policy, protocolAllowlist);
    const bindings = validateCandidateBindings(
      protocolAllowlist.candidateLiveCaptureBindings,
      suiteRoot,
    );
    const selectorSeeds = loadCandidateSelectorSeeds({
      suiteRoot,
      protocolAllowlist,
      policy,
    });
    const scopedBindings = bindings.map((binding) => {
      const seed = selectorSeeds.byScope.get(binding.scopeId);
      return {
        ...binding,
        ...(seed ? {
          selectorSeedProjectionSha256: seed.projectionSha256,
          allowedSelectorSha256: seed.allowedSelectorSha256,
        } : {}),
      };
    });
    return {
      mode: "candidate",
      status: "pending_selector_scoped_scrub_only",
      policy,
      bindings: scopedBindings,
      policySha256: canonicalSha256({
        bindings: scopedBindings,
        policy,
        selectorSeedSha256: selectorSeeds.seedSha256,
      }),
      selectorSeedSha256: selectorSeeds.seedSha256,
      acceptedIndexSha256: null,
      acceptedShapesSha256: null,
    };
  }
  if (mode !== "accepted") throw new Error("live exact policy mode is outside reviewed set");
  throw new Error(
    "accepted_live_exact_attestation_required: protected v3 structural attestation is unavailable",
  );
}

export function candidateBindingFor(policyState, fixtureStem, capture) {
  if (policyState.mode !== "candidate") return undefined;
  const matches = policyState.bindings.filter((binding) =>
    binding.fixtureStem === fixtureStem && binding.capture === capture);
  if (matches.length !== 1) {
    throw new Error(`live candidate is outside capture binding: ${fixtureStem}`);
  }
  if (!Array.isArray(matches[0].allowedSelectorSha256)
    || matches[0].allowedSelectorSha256.length === 0) {
    throw new Error(`live candidate has no independently reviewable selector seed: ${fixtureStem}`);
  }
  return matches[0];
}

export function liveBindingFor(policyState, fixtureStem, capture) {
  if (policyState.mode === "candidate") {
    return candidateBindingFor(policyState, fixtureStem, capture);
  }
  const matches = policyState.bindings.filter((binding) =>
    binding.fixtureStem === fixtureStem && binding.capture === capture);
  if (matches.length !== 1) {
    throw new Error(`live fixture is outside accepted artifact union: ${fixtureStem}`);
  }
  return matches[0];
}
