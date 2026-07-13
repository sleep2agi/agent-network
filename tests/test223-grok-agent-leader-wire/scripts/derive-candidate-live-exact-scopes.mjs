import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  jsonRpcIdKey,
  orderProjectionEntries,
} from "../lib/rpc-order.mjs";
import { GROK_WIRE_BASELINE } from "../lib/grok-wire-baseline.mjs";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export { GROK_WIRE_BASELINE };
const TARGET_TRANSPORTS = new Set(["leader-native-ipc", "acp-stdio"]);
const MESSAGE_KINDS = new Set(["notification", "outer-message", "request", "response"]);
const JSON_TYPES = new Set(["array", "boolean", "null", "number", "object", "string"]);
const INCOMPLETE_PARSE_STATUSES = new Map([
  ["leader-native-ipc", new Set([
    "clean_eof",
    "invalid_inner_acp_payload",
    "invalid_native_json",
    "native_frame_too_large",
    "truncated_native_payload",
  ])],
  ["acp-stdio", new Set(["invalid_json", "truncated_json"])],
]);
const COMPLETE_PARSE_STATUS = new Map([
  ["leader-native-ipc", "complete_native_json"],
  ["acp-stdio", "complete_json"],
]);
const GENERIC_PLACEHOLDER = /^<[A-Z][A-Z0-9_]*_\d+>$/;
const TYPED_STRING_SHA256 = /^sha256:[0-9a-f]{64}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function canonical(value) {
  return JSON.stringify(stable(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reject(message) {
  throw new Error(message);
}

function isClosedValue(value) {
  return typeof value === "string"
    && (GENERIC_PLACEHOLDER.test(value) || value.trim().toLowerCase() === "unresolved");
}

function assertReviewedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || isClosedValue(value)) {
    reject(`${label} is missing, unresolved, or a generic placeholder`);
  }
  return value;
}

function normalizeSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    reject("candidate selector must be an object");
  }
  const messageKind = assertReviewedString(selector.messageKind, "candidate messageKind");
  const expectedKeys = messageKind === "outer-message"
    ? ["messageKind", "outerType", "transport"]
    : ["messageKind", "method", "outerType", "transport"];
  if (canonical(Object.keys(selector).sort()) !== canonical(expectedKeys.sort())) {
    reject("candidate selector has fields outside the exact selector schema");
  }
  if (!TARGET_TRANSPORTS.has(selector.transport)
    || !MESSAGE_KINDS.has(messageKind)) {
    reject("candidate selector transport/messageKind is outside the reviewed set");
  }
  const normalized = {
    transport: selector.transport,
    outerType: assertReviewedString(selector.outerType, "candidate outerType"),
    messageKind,
  };
  if (messageKind !== "outer-message") {
    normalized.method = assertReviewedString(selector.method, "candidate method");
  }
  return normalized;
}

function scalarKey(value) {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n:${String(value)}`;
  reject("candidate exact scalar is not a finite number, boolean, or reviewed string");
}

function normalizeShape(shape) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)
    || canonical(Object.keys(shape).sort()) !== canonical(["enums", "paths"])) {
    reject("candidate shape has fields outside paths/enums");
  }
  if (!Array.isArray(shape.paths) || shape.paths.length === 0 || !Array.isArray(shape.enums)) {
    reject("candidate shape paths/enums are malformed");
  }
  const pathKeys = new Set();
  const paths = shape.paths.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || canonical(Object.keys(entry).sort()) !== canonical(["path", "type"])
      || typeof entry.path !== "string"
      || !(entry.path === "$outer" || entry.path.startsWith("$outer.")
        || entry.path === "$rpc" || entry.path.startsWith("$rpc."))
      || !JSON_TYPES.has(entry.type)) {
      reject("candidate shape path is malformed");
    }
    const key = `${entry.path}\u0000${entry.type}`;
    if (pathKeys.has(key)) reject("candidate shape contains a duplicate path/type");
    pathKeys.add(key);
    return { path: entry.path, type: entry.type };
  }).sort((left, right) => left.path.localeCompare(right.path)
    || left.type.localeCompare(right.type));

  const enumPaths = new Set();
  const pathNames = new Set(paths.map(({ path }) => path));
  const enums = shape.enums.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || canonical(Object.keys(entry).sort()) !== canonical(["path", "values"])
      || typeof entry.path !== "string" || !pathNames.has(entry.path)
      || !Array.isArray(entry.values) || entry.values.length === 0) {
      reject("candidate exact scalar entry is malformed");
    }
    if (enumPaths.has(entry.path)) reject("candidate shape contains a duplicate exact scalar path");
    enumPaths.add(entry.path);
    const valuesByKey = new Map();
    for (const value of entry.values) {
      if (isClosedValue(value)) {
        reject("candidate exact scalar contains an unresolved/generic placeholder value");
      }
      const key = scalarKey(value);
      if (valuesByKey.has(key)) reject("candidate exact scalar set contains a duplicate value");
      valuesByKey.set(key, value);
    }
    return {
      path: entry.path,
      values: [...valuesByKey.values()].sort((left, right) =>
        canonical(left).localeCompare(canonical(right))),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { paths, enums };
}

function buildCandidateIndex(policy) {
  if (!policy || policy.schema !== "test223-live-exact-candidate/v1"
    || policy.source !== "capture-scoped-pending-independent-review"
    || !Array.isArray(policy.opaqueSubtreeKeys)
    || !Array.isArray(policy.opaqueStructuralKeys)
    || !Array.isArray(policy.selectors) || policy.selectors.length === 0) {
    reject("candidate live exact policy is absent or has an unsupported schema/source");
  }
  const opaqueSubtreeKeys = new Set();
  const opaqueStructuralKeys = new Set();
  for (const [label, values, target] of [
    ["opaque subtree key", policy.opaqueSubtreeKeys, opaqueSubtreeKeys],
    ["opaque structural key", policy.opaqueStructuralKeys, opaqueStructuralKeys],
  ]) {
    for (const value of values) {
      assertReviewedString(value, label);
      if (target.has(value)) reject(`candidate policy contains a duplicate ${label}`);
      target.add(value);
    }
  }

  const selectors = new Map();
  const exactScalarPaths = new Set();
  const exactStringEncodingByPath = new Map();
  const reviewedMethods = new Set();
  const reviewedOuterTypes = new Set();
  const reviewedPaths = new Set();
  for (const entry of policy.selectors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || canonical(Object.keys(entry).sort()) !== canonical(["selector", "shapes"])
      || !Array.isArray(entry.shapes) || entry.shapes.length === 0) {
      reject("candidate selector entry is malformed or empty");
    }
    const selector = normalizeSelector(entry.selector);
    reviewedOuterTypes.add(selector.outerType);
    if (selector.method !== undefined) reviewedMethods.add(selector.method);
    const selectorKey = canonical(selector);
    if (selectors.has(selectorKey)) reject("candidate policy contains a duplicate selector");
    const shapes = new Map();
    for (const rawShape of entry.shapes) {
      const shape = normalizeShape(rawShape);
      const shapeKey = canonical(shape);
      if (shapes.has(shapeKey)) reject("candidate selector contains a duplicate shape");
      for (const { path } of shape.paths) reviewedPaths.add(path);
      for (const exact of shape.enums) {
        exactScalarPaths.add(exact.path);
        const strings = exact.values.filter((value) => typeof value === "string");
        const containsHash = strings.some((value) => TYPED_STRING_SHA256.test(value));
        const containsLiteral = strings.some((value) => !TYPED_STRING_SHA256.test(value));
        if (containsHash && containsLiteral) {
          reject("candidate exact scalar set mixes typed-string fingerprints and literals");
        }
        const encoding = containsHash
          ? "typed-string-sha256"
          : containsLiteral
            ? "literal"
            : undefined;
        const prior = exactStringEncodingByPath.get(exact.path);
        if (encoding && prior && encoding !== prior) {
          reject("candidate exact scalar path changes string encoding between shapes");
        }
        if (encoding) exactStringEncodingByPath.set(exact.path, encoding);
      }
      const hashInput = { selector, paths: shape.paths, enums: shape.enums };
      shapes.set(shapeKey, {
        ...shape,
        allowedShapeSha256: sha256(canonical(hashInput)),
      });
    }
    selectors.set(selectorKey, { selector, shapes });
  }
  return {
    opaqueSubtreeKeys,
    opaqueStructuralKeys,
    exactScalarPaths,
    exactStringEncodingByPath,
    reviewedMethods,
    reviewedOuterTypes,
    reviewedPaths,
    selectors,
  };
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function collectObservedShape(outer, rpc, policyIndex) {
  const pathTypes = new Map();
  const scalarValues = new Map();
  const record = (value, path) => {
    const type = jsonType(value);
    if (!JSON_TYPES.has(type)) reject(`projection contains unsupported JSON type at ${path}`);
    if (!pathTypes.has(path)) pathTypes.set(path, new Set());
    pathTypes.get(path).add(type);
    if (["string", "number", "boolean"].includes(type)
      && policyIndex.exactScalarPaths.has(path)) {
      if (isClosedValue(value)) {
        reject(`projection exact scalar is unresolved or a generic placeholder at ${path}`);
      }
      // sanitize.mjs persists raw strings on hashed paths as
      // sha256("string:" + raw). A safe projection therefore must already
      // contain that typed fingerprint. Re-hashing it here would silently
      // change the sanitizer/verifier contract.
      if (type === "string"
        && policyIndex.exactStringEncodingByPath.get(path) === "typed-string-sha256"
        && !TYPED_STRING_SHA256.test(value)) {
        reject(`projection exact scalar lacks the persisted typed-string fingerprint at ${path}`);
      }
      scalarKey(value);
      if (!scalarValues.has(path)) scalarValues.set(path, new Map());
      scalarValues.get(path).set(scalarKey(value), value);
    }
    return type;
  };
  const visit = (value, path, key, opaque = false) => {
    const type = record(value, path);
    const childOpaque = opaque || policyIndex.opaqueSubtreeKeys.has(key);
    if (type === "array") {
      for (const child of value) visit(child, `${path}[]`, undefined, childOpaque);
      return;
    }
    if (type !== "object") return;
    for (const childKey of Object.keys(value).sort()) {
      if (childOpaque && !policyIndex.opaqueStructuralKeys.has(childKey)) continue;
      visit(value[childKey], `${path}.${childKey}`, childKey, childOpaque);
    }
  };
  if (outer !== undefined) visit(outer, "$outer", undefined);
  if (rpc !== undefined) visit(rpc, "$rpc", undefined);
  return normalizeShape({
    paths: [...pathTypes]
      .flatMap(([path, types]) => [...types].map((type) => ({ path, type }))),
    enums: [...scalarValues]
      .map(([path, values]) => ({ path, values: [...values.values()] })),
  });
}

function safeSelectorDiagnostic(selector, policyIndex) {
  return {
    transport: selector.transport,
    outerType: policyIndex.reviewedOuterTypes.has(selector.outerType)
      ? selector.outerType
      : "<UNREVIEWED_OUTER_TYPE>",
    messageKind: selector.messageKind,
    ...(selector.method === undefined
      ? {}
      : {
        method: policyIndex.reviewedMethods.has(selector.method)
          ? selector.method
          : "<UNREVIEWED_METHOD>",
      }),
  };
}

function mismatchDiagnostic(selector, observed, candidate, policyIndex) {
  const observedPaths = new Set(observed.paths.map(({ path, type }) => `${path}\u0000${type}`));
  const observedScalars = new Map(observed.enums.map(({ path, values }) => [path, canonical(values)]));
  let closest;
  for (const shape of candidate.shapes.values()) {
    const candidatePaths = new Set(shape.paths.map(({ path, type }) => `${path}\u0000${type}`));
    const missing = [...candidatePaths].filter((value) => !observedPaths.has(value));
    const unexpected = [...observedPaths].filter((value) => !candidatePaths.has(value));
    const score = missing.length + unexpected.length;
    if (!closest || score < closest.score) closest = { shape, missing, unexpected, score };
  }
  const diagnostic = { selector: safeSelectorDiagnostic(selector, policyIndex) };
  if (closest?.score === 0) {
    const candidateScalars = new Map(
      closest.shape.enums.map(({ path, values }) => [path, canonical(values)]),
    );
    diagnostic.mismatchKind = "scalar";
    diagnostic.exactScalarPaths = [...new Set([
      ...observedScalars.keys(),
      ...candidateScalars.keys(),
    ].filter((path) => observedScalars.get(path) !== candidateScalars.get(path)))].sort();
    return diagnostic;
  }
  diagnostic.mismatchKind = "path";
  diagnostic.missingReviewedPaths = (closest?.missing ?? [])
    .map((value) => value.split("\u0000")[0])
    .sort();
  diagnostic.unexpectedReviewedPaths = (closest?.unexpected ?? [])
    .map((value) => value.split("\u0000")[0])
    .filter((path) => policyIndex.reviewedPaths.has(path))
    .sort();
  diagnostic.unreviewedUnexpectedPathCount = (closest?.unexpected ?? []).length
    - diagnostic.unexpectedReviewedPaths.length;
  return diagnostic;
}

function reverseDirection(direction) {
  if (typeof direction !== "string") return undefined;
  const separator = "_to_";
  const split = direction.indexOf(separator);
  if (split <= 0 || split !== direction.lastIndexOf(separator)) return undefined;
  const source = direction.slice(0, split);
  const destination = direction.slice(split + separator.length);
  if (!source || !destination) return undefined;
  return `${destination}${separator}${source}`;
}

function correlationKey(row, direction, id) {
  return canonical([
    row.capture,
    row.transport,
    row.connection,
    direction,
    jsonRpcIdKey(id),
  ]);
}

function completeMessage(row) {
  if (!TARGET_TRANSPORTS.has(row.transport)) return undefined;
  const completeStatus = COMPLETE_PARSE_STATUS.get(row.transport);
  if (row.parseStatus !== completeStatus) {
    if (!INCOMPLETE_PARSE_STATUSES.get(row.transport)?.has(row.parseStatus)) {
      reject("projection target transport has an unknown parse status");
    }
    return undefined;
  }
  if (row.transport === "leader-native-ipc") {
    if (!row.outer || typeof row.outer !== "object" || Array.isArray(row.outer)) {
      reject("complete native frame has no outer object");
    }
    const outerType = assertReviewedString(row.outer.type, "projection outer type");
    if (outerType === "acp") {
      if (!row.inner || typeof row.inner !== "object" || Array.isArray(row.inner)
        || typeof row.outer.payload !== "string") {
        reject("complete native ACP frame has no projected inner object/string payload");
      }
      let parsed;
      try {
        parsed = JSON.parse(row.outer.payload);
      } catch {
        reject("complete native ACP payload is not JSON");
      }
      if (canonical(parsed) !== canonical(row.inner)) {
        reject("complete native ACP outer payload and inner projection differ");
      }
      return { outer: row.outer, rpc: row.inner };
    }
    if (row.inner !== undefined) reject("non-ACP native frame unexpectedly has an inner projection");
    return { outer: row.outer, rpc: undefined };
  }
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    reject("complete ACP stdio frame has no payload object");
  }
  return { outer: undefined, rpc: row.payload };
}

function describeRpc(rpc) {
  if (rpc === undefined) return { messageKind: "outer-message" };
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) {
    reject("complete projected RPC is not an object");
  }
  if (typeof rpc.method === "string") {
    assertReviewedString(rpc.method, "projection RPC method");
    if (own(rpc, "result") || own(rpc, "error")) {
      reject("projected RPC mixes method with response fields");
    }
    if (own(rpc, "id")) jsonRpcIdKey(rpc.id);
    return {
      messageKind: own(rpc, "id") ? "request" : "notification",
      method: rpc.method,
    };
  }
  if (!own(rpc, "id") || own(rpc, "result") === own(rpc, "error")) {
    reject("projected RPC is neither an exact request/notification nor exact response");
  }
  jsonRpcIdKey(rpc.id);
  return { messageKind: "response" };
}

function normalizeProjectionRows(text, label) {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) reject(`${label}: projection is empty`);
  const rows = lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      reject(`${label}: projection line ${index + 1} is not JSON`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)
      || row.schema !== "grok-wire-projection/v1") {
      reject(`${label}: projection line ${index + 1} has an unsupported schema`);
    }
    assertReviewedString(row.capture, "projection capture");
    assertReviewedString(row.connection, "projection connection");
    assertReviewedString(row.direction, "projection direction");
    assertReviewedString(row.transport, "projection transport");
    return row;
  });
  return orderProjectionEntries(rows);
}

function deriveFixture(
  { stem, projectionPath, projectionBytes },
  policyIndex,
  bindings,
  { selectorSeedOnly = false, allowedDirections } = {},
) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(stem)) reject("fixture stem is outside the safe naming grammar");
  const bytes = projectionBytes ?? readFileSync(projectionPath);
  const rows = normalizeProjectionRows(bytes.toString("utf8"), stem);
  const captures = new Set(rows.map((row) => row.capture));
  if (captures.size !== 1) reject(`${stem}: projection contains multiple capture values`);
  const capture = [...captures][0];
  const binding = bindings.filter((entry) => entry?.fixtureStem === stem && entry?.capture === capture);
  if (binding.length !== 1) reject(`${stem}: fixture/capture is not uniquely candidate-bound`);
  assertReviewedString(binding[0].scopeId, "candidate binding scopeId");

  const pending = new Map();
  const shapeHashes = new Set();
  const selectorHashes = new Set();
  let completeFrameCount = 0;
  for (const row of rows) {
    const projected = completeMessage(row);
    if (!projected) continue;
    if (!allowedDirections?.has(row.direction)) {
      reject(`${stem}: projection direction is outside reviewed metadata values`);
    }
    completeFrameCount += 1;
    const descriptor = describeRpc(projected.rpc);
    let method = descriptor.method;
    if (descriptor.messageKind === "request") {
      const key = correlationKey(row, row.direction, projected.rpc.id);
      if (pending.has(key)) {
        reject(`${stem}: concurrent request correlation is ambiguous`);
      }
      pending.set(key, method);
    } else if (descriptor.messageKind === "response") {
      const opposite = reverseDirection(row.direction);
      if (!opposite) reject(`${stem}: response direction has no exact reverse lane`);
      const key = correlationKey(row, opposite, projected.rpc.id);
      if (!pending.has(key)) {
        reject(`${stem}: response lacks strict connection/direction/typed-id correlation`);
      }
      method = pending.get(key);
      pending.delete(key);
    }
    const policySelector = {
      transport: row.transport,
      outerType: projected.outer === undefined ? "not-applicable" : projected.outer.type,
      messageKind: descriptor.messageKind,
      ...(method === undefined ? {} : { method }),
    };
    const selector = { ...policySelector, direction: row.direction };
    const candidate = policyIndex.selectors.get(canonical(policySelector));
    if (!candidate) {
      reject(`${stem}: complete frame selector is outside candidate exact policy; diagnostics=${canonical({
        selector: safeSelectorDiagnostic(policySelector, policyIndex),
      })}`);
    }
    if (selectorSeedOnly) {
      selectorHashes.add(sha256(canonical({ namespace: GROK_WIRE_BASELINE, selector })));
      continue;
    }
    const observed = collectObservedShape(projected.outer, projected.rpc, policyIndex);
    const matched = candidate.shapes.get(canonical(observed));
    if (!matched) {
      reject(`${stem}: complete frame shape/exact scalars are outside candidate policy; diagnostics=${canonical(
        mismatchDiagnostic(policySelector, observed, candidate, policyIndex),
      )}`);
    }
    shapeHashes.add(sha256(canonical({
      namespace: GROK_WIRE_BASELINE,
      selector,
      paths: matched.paths,
      enums: matched.enums,
    })));
  }
  if (completeFrameCount === 0) reject(`${stem}: projection has no complete target transport frames`);
  return {
    scopeId: binding[0].scopeId,
    fixtureStem: stem,
    capture,
    projectionFile: basename(projectionPath ?? `${stem}.projection.ndjson`),
    projectionSha256: sha256(bytes),
    completeFrameCount,
    ...(selectorSeedOnly
      ? { allowedSelectorSha256: [...selectorHashes].sort() }
      : { allowedShapeSha256: [...shapeHashes].sort() }),
  };
}

export function deriveCandidateScopes({ allowlistPath, fixtures, selectorSeedOnly = false }) {
  if (typeof allowlistPath !== "string" || !Array.isArray(fixtures) || fixtures.length === 0) {
    reject("deriveCandidateScopes requires allowlistPath and one or more fixtures");
  }
  const allowlistBytes = readFileSync(allowlistPath);
  const allowlist = JSON.parse(allowlistBytes.toString("utf8"));
  if (allowlist.schema !== "test223-protocol-allowlist/v2"
    || !Array.isArray(allowlist.candidateLiveCaptureBindings)) {
    reject("protocol allowlist schema/candidate bindings are unsupported");
  }
  const policy = allowlist.candidateLiveExactShapePolicy;
  const policyIndex = buildCandidateIndex(policy);
  const allowedDirections = new Set(allowlist.metadata?.values?.direction || []);
  if (allowedDirections.size === 0) reject("reviewed direction metadata values are missing");
  const seen = new Set();
  const derived = fixtures.map((fixture) => {
    const value = deriveFixture(
      fixture,
      policyIndex,
      allowlist.candidateLiveCaptureBindings,
      { selectorSeedOnly, allowedDirections },
    );
    const key = canonical([value.fixtureStem, value.capture]);
    if (seen.has(key)) reject("duplicate fixtureStem/capture input");
    seen.add(key);
    return value;
  }).sort((left, right) => left.fixtureStem.localeCompare(right.fixtureStem)
    || left.capture.localeCompare(right.capture));
  return {
    schema: selectorSeedOnly
      ? "test223-candidate-live-selector-seeds/v1"
      : "test223-candidate-live-exact-scopes/v1",
    status: "pending-independent-fixture-acceptance",
    authorizesPersistence: false,
    authorizesExactShapeAcceptance: false,
    source: selectorSeedOnly
      ? "stale-projection-selector-only"
      : "candidate-policy-plus-current-safe-projection",
    namespace: GROK_WIRE_BASELINE,
    candidateBindingSetSha256: sha256(canonical(allowlist.candidateLiveCaptureBindings)),
    candidatePolicySha256: sha256(canonical(policy)),
    fixtures: derived,
  };
}

function parseCli(argv) {
  let allowlistPath;
  let outputPath;
  let selectorSeedOnly = false;
  const fixtures = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--selector-seed-only") {
      if (selectorSeedOnly) reject("--selector-seed-only may appear only once");
      selectorSeedOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!["--allowlist", "--output", "--fixture"].includes(option) || value === undefined) {
      reject("usage: derive-candidate-live-exact-scopes.mjs [--selector-seed-only] --allowlist PATH --output PATH --fixture STEM=PROJECTION [--fixture ...]");
    }
    index += 1;
    if (option === "--allowlist") {
      if (allowlistPath) reject("--allowlist may appear only once");
      allowlistPath = value;
    } else if (option === "--output") {
      if (outputPath) reject("--output may appear only once");
      outputPath = value;
    } else {
      const split = value.indexOf("=");
      if (split <= 0 || split === value.length - 1) reject("--fixture must be STEM=PROJECTION");
      fixtures.push({ stem: value.slice(0, split), projectionPath: value.slice(split + 1) });
    }
  }
  if (!allowlistPath || !outputPath || fixtures.length === 0) {
    reject("usage: derive-candidate-live-exact-scopes.mjs [--selector-seed-only] --allowlist PATH --output PATH --fixture STEM=PROJECTION [--fixture ...]");
  }
  return { allowlistPath, outputPath, fixtures, selectorSeedOnly };
}

function main() {
  const {
    allowlistPath,
    outputPath,
    fixtures,
    selectorSeedOnly,
  } = parseCli(process.argv.slice(2));
  const result = deriveCandidateScopes({ allowlistPath, fixtures, selectorSeedOnly });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    schema: result.schema,
    status: result.status,
    fixtureCount: result.fixtures.length,
    scopeDigestCount: result.fixtures.reduce(
      (total, fixture) => total + (
        fixture.allowedShapeSha256 ?? fixture.allowedSelectorSha256
      ).length,
      0,
    ),
  })}\n`);
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
