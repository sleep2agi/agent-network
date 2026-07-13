import { readFileSync, writeFileSync } from "node:fs";

const [summaryPath, allowlistPath, proposalPath] = process.argv.slice(2);
if (!summaryPath || !allowlistPath || !proposalPath) {
  throw new Error(
    "usage: generate-live-exact-shapes.mjs SAFE_SHAPE_SUMMARY PROTOCOL_ALLOWLIST CANDIDATE_PROPOSAL",
  );
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
if (summary.schema !== "grok-raw-structure-summary" || !Array.isArray(summary.groups)) {
  throw new Error("unsupported safe shape summary");
}

const transports = new Set(["leader-native-ipc", "acp-stdio"]);
const messageKinds = new Set(["notification", "outer-message", "request", "response"]);
const valueTypes = new Set(["array", "boolean", "null", "number", "object", "string"]);
const opaqueSubtreeKeys = [
  "access_token", "account", "apiKey", "api_key", "args", "arguments", "argv",
  "authorization", "availableCommands", "billing", "body", "clientCommands", "command",
  "commandLine", "command_line", "content", "cookie", "cwd", "encryptedContent",
  "encrypted_content", "email", "executable", "filePath", "gitRoot", "history", "input",
  "log", "logs", "message", "output", "password", "path", "payload", "prompt", "prompts",
  "rawInput", "reasoning", "refresh_token", "secret", "serverKey", "sessionSummary",
  "session_summary", "sid", "slash_command", "text", "title", "token", "toolResult",
  "tool_result", "user", "username",
];
const opaqueStructuralKeys = [
  "jsonrpc", "kind", "method", "mode", "outcome", "role", "sessionUpdate",
  "session_update", "severity", "status", "stopReason", "stop_reason", "type",
  "updateType", "update_type",
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function validateSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new Error("shape selector must be an object");
  }
  const keys = Object.keys(selector).sort();
  const expected = selector.messageKind === "outer-message"
    ? ["connection", "direction", "messageKind", "outerType", "transport"]
    : ["connection", "direction", "messageKind", "method", "outerType", "transport"];
  if (JSON.stringify(keys) !== JSON.stringify(expected.sort())) {
    throw new Error("shape selector fields are outside the safe summary schema");
  }
  if (!transports.has(selector.transport)
    || !messageKinds.has(selector.messageKind)
    || typeof selector.outerType !== "string") {
    throw new Error("shape selector value is outside the reviewed set");
  }
  if (selector.messageKind !== "outer-message" && typeof selector.method !== "string") {
    throw new Error("RPC shape selector has no method");
  }
}

function validateShape(shape) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)
    || !Array.isArray(shape.paths) || !Array.isArray(shape.enums)) {
    throw new Error("shape entry is malformed");
  }
  const seenPaths = new Set();
  for (const entry of shape.paths) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith("$")
      || !valueTypes.has(entry.type)) {
      throw new Error("shape path is malformed");
    }
    if (seenPaths.has(entry.path)) throw new Error("shape contains a duplicate path");
    seenPaths.add(entry.path);
  }
  for (const entry of shape.enums) {
    if (!entry || typeof entry.path !== "string" || !seenPaths.has(entry.path)
      || !Array.isArray(entry.values) || entry.values.length === 0
      || entry.values.some((value) => !(typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))))) {
      throw new Error("shape enum is malformed");
    }
  }
}

const selectors = new Map();
for (const group of summary.groups) {
  validateSelector(group.selector);
  if (!Array.isArray(group.shapes) || group.shapes.length === 0) {
    throw new Error("shape selector has no variants");
  }
  const selector = {
    transport: group.selector.transport,
    outerType: group.selector.outerType,
    messageKind: group.selector.messageKind,
    ...(group.selector.method === undefined ? {} : { method: group.selector.method }),
  };
  const selectorKey = canonical(selector);
  if (!selectors.has(selectorKey)) selectors.set(selectorKey, { selector, shapes: new Map() });
  for (const shape of group.shapes) {
    validateShape(shape);
    const normalized = {
      paths: [...shape.paths]
        .map(({ path, type }) => ({ path, type }))
        .sort((left, right) => left.path.localeCompare(right.path)
          || left.type.localeCompare(right.type)),
      enums: [...shape.enums]
        .map(({ path, values }) => ({
          path,
          values: [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    selectors.get(selectorKey).shapes.set(canonical(normalized), normalized);
  }
}

const exactSelectors = [...selectors.values()]
  .map(({ selector, shapes }) => ({
    selector,
    shapes: [...shapes.values()].sort((left, right) => canonical(left).localeCompare(canonical(right))),
  }))
  .sort((left, right) => canonical(left.selector).localeCompare(canonical(right.selector)));

// The exact path policy and the persisted field-name policy must form a
// closed set. Derive direct child keys from the nearest observed object path;
// splitting on dots would misread real protocol keys such as `x.ai/tool`.
const reviewedFields = new Set(allowlist.jsonFields || []);
const uncoveredFields = new Set();
for (const { shapes } of exactSelectors) {
  for (const shape of shapes) {
    const objectPaths = shape.paths
      .filter(({ type }) => type === "object")
      .map(({ path }) => path);
    for (const { path } of shape.paths) {
      const parent = objectPaths
        .filter((candidate) => path.startsWith(`${candidate}.`))
        .sort((left, right) => right.length - left.length)[0];
      if (!parent) continue;
      const field = path.slice(parent.length + 1);
      if (!field || field.includes("[]")) continue;
      if (!reviewedFields.has(field)) uncoveredFields.add(field);
    }
  }
}
if (uncoveredFields.size > 0) {
  throw new Error(
    `exact shape contains fields outside jsonFields: ${[...uncoveredFields].sort().join(",")}`,
  );
}

if (exactSelectors.length !== 60
  || exactSelectors.reduce((total, entry) => total + entry.shapes.length, 0) !== 118) {
  throw new Error("safe summary selector/shape cardinality changed; explicit review is required");
}

const proposal = {
  schema: "test223-live-exact-candidate-proposal/v1",
  status: "pending_external_fixture_acceptance",
  authorizesPersistence: false,
  source: "safe-structural-summary-proposal-only",
  opaqueSubtreeKeys,
  opaqueStructuralKeys,
  selectors: exactSelectors,
};
writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
