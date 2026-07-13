import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateSelectorSha256,
  liveBindingFor,
  loadLiveExactPolicy,
} from "../lib/live-exact-policy.mjs";

const [input, output, mapPath] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: sanitize.mjs RAW_NDJSON SAFE_NDJSON [RAW_MAP]");
const protocolAllowlist = JSON.parse(readFileSync(
  new URL("../protocol-allowlist.json", import.meta.url),
  "utf8",
));
if (protocolAllowlist.schema !== "test223-protocol-allowlist/v2") {
  throw new Error("unsupported protocol allowlist schema");
}
const allowedMethods = new Set(protocolAllowlist.methods);
const allowedJsonFields = new Set(protocolAllowlist.jsonFields);
const allowedMetadataKeys = new Set(protocolAllowlist.metadata.keys);
const allowedMetadataValues = new Map(
  Object.entries(protocolAllowlist.metadata.values).map(([key, values]) => [key, new Set(values)]),
);
const requiredEnumValues = new Map(
  Object.entries(protocolAllowlist.enums).map(([key, values]) => [key, new Set(values)]),
);
const correlationLabelsByKey = new Map(Object.entries(protocolAllowlist.correlations.keys));
const jsonRpcIdLabel = protocolAllowlist.correlations.jsonRpcIdLabel;
const livePathPolicy = protocolAllowlist.livePathPolicy;
if (!livePathPolicy?.nativeOuterByType || !livePathPolicy?.rpcByMethod
  || !livePathPolicy?.rpcResponseByMethod
  || !Array.isArray(livePathPolicy.rpcCommon)
  || !Array.isArray(livePathPolicy.rpcResponseCommon)) {
  throw new Error("live path policy is incomplete");
}
const suiteRoot = fileURLToPath(new URL("../", import.meta.url));
const livePolicyState = loadLiveExactPolicy({ suiteRoot, protocolAllowlist });
const liveExactShapePolicy = livePolicyState.policy;
const exactLiveTransports = new Set(["leader-native-ipc", "acp-stdio"]);
const exactOpaqueSubtreeKeys = new Set(liveExactShapePolicy.opaqueSubtreeKeys);
const exactOpaqueStructuralKeys = new Set(liveExactShapePolicy.opaqueStructuralKeys);
const exactEnumPaths = new Set();
const exactHashedScalarPaths = new Set();
const exactScalarEncodingByPath = new Map();
const exactShapeSelectors = new Map();

function canonicalSelector(selector) {
  return JSON.stringify({
    transport: selector.transport,
    outerType: selector.outerType,
    messageKind: selector.messageKind,
    ...(selector.method === undefined ? {} : { method: selector.method }),
  });
}

function canonicalPaths(paths) {
  return JSON.stringify([...paths]
    .map(({ path, type }) => ({ path, type }))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.type.localeCompare(right.type)));
}

function canonicalEnums(enums) {
  return JSON.stringify([...enums]
    .map(({ path, values }) => ({
      path,
      values: [...values]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

for (const entry of liveExactShapePolicy.selectors) {
  if (!entry?.selector || !Array.isArray(entry.shapes) || entry.shapes.length === 0) {
    throw new Error("live exact shape selector is malformed");
  }
  const key = canonicalSelector(entry.selector);
  if (exactShapeSelectors.has(key)) throw new Error("duplicate live exact shape selector");
  const shapes = entry.shapes.map((shape) => {
    if (!Array.isArray(shape?.paths) || !Array.isArray(shape?.enums)) {
      throw new Error("live exact shape variant is malformed");
    }
    for (const item of shape.enums) {
      if (typeof item?.path !== "string" || !Array.isArray(item.values)
        || item.values.length === 0
        || item.values.some((value) => !(typeof value === "string"
          || typeof value === "boolean"
          || (typeof value === "number" && Number.isFinite(value))))) {
        throw new Error("live exact scalar set is malformed");
      }
      exactEnumPaths.add(item.path);
      const containsHash = item.values.some((value) => typeof value === "string"
        && /^sha256:[0-9a-f]{64}$/.test(value));
      const containsLiteralString = item.values.some((value) => typeof value === "string"
        && !/^sha256:[0-9a-f]{64}$/.test(value));
      if (containsHash && containsLiteralString) {
        throw new Error("live exact scalar set mixes hashed and literal values");
      }
      const stringEncoding = containsHash
        ? "typed-string-sha256"
        : containsLiteralString
          ? "literal"
          : undefined;
      const priorEncoding = exactScalarEncodingByPath.get(item.path);
      if (stringEncoding && priorEncoding && priorEncoding !== stringEncoding) {
        throw new Error("live exact string scalar path changes encoding between shape variants");
      }
      if (stringEncoding) exactScalarEncodingByPath.set(item.path, stringEncoding);
      if (containsHash) {
        exactHashedScalarPaths.add(item.path);
        if (item.path.startsWith("$rpc.")) {
          exactHashedScalarPaths.add(item.path.slice("$rpc.".length));
        } else if (item.path.startsWith("$outer.")) {
          exactHashedScalarPaths.add(item.path.slice("$outer.".length));
        }
      }
    }
    return {
      paths: shape.paths,
      enums: shape.enums,
      pathSignature: canonicalPaths(shape.paths),
      enumSignature: canonicalEnums(shape.enums),
    };
  });
  exactShapeSelectors.set(key, shapes);
}
const policyIpc = protocolAllowlist.policyIpc;
if (policyIpc?.transport !== "test-policy-ipc"
  || policyIpc?.framing !== "newline-delimited-json"
  || !policyIpc.messageFields
  || !Array.isArray(policyIpc.scenarios)
  || !Array.isArray(policyIpc.actions)
  || !Array.isArray(policyIpc.decisions)
  || !Array.isArray(policyIpc.requestRefFields)
  || !Array.isArray(policyIpc.requestRefConnections)
  || !Array.isArray(policyIpc.controlConnections)
  || !Array.isArray(policyIpc.leaderResponseDeltas)) {
  throw new Error("policy IPC schema is incomplete");
}
const policyMessageFields = new Map(Object.entries(policyIpc.messageFields)
  .map(([type, fields]) => [type, new Set(fields)]));
const policyScenarios = new Set(policyIpc.scenarios);
const policyActions = new Set(policyIpc.actions);
const policyDecisions = new Set(policyIpc.decisions);
const policyRequestRefFields = new Set(policyIpc.requestRefFields);
const policyRequestRefConnections = new Set(policyIpc.requestRefConnections);
const policyControlConnections = new Set(policyIpc.controlConnections);
const policyLeaderResponseDeltas = new Set(policyIpc.leaderResponseDeltas);

const records = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const rawName = basename(input);
if (!rawName.endsWith(".raw.ndjson")) {
  throw new Error("raw fixture filename does not carry a reviewed fixture stem");
}
const fixtureStem = rawName.slice(0, -".raw.ndjson".length);
const liveCaptures = [...new Set(records
  .map((record) => record?.capture)
  .filter((capture) => capture !== undefined && capture !== "harness-canary"))];
if (liveCaptures.length > 1) {
  throw new Error("raw live fixture contains more than one capture identity");
}
let liveFixtureBinding;
if (liveCaptures.length === 1) {
  liveFixtureBinding = liveBindingFor(livePolicyState, fixtureStem, liveCaptures[0]);
}
const placeholderMaps = new Map();
const correlationMaps = new Map();
if (mapPath && existsSync(mapPath)) {
  const saved = JSON.parse(readFileSync(mapPath, "utf8"));
  for (const [kind, entries] of Object.entries(saved.placeholders || saved)) {
    placeholderMaps.set(kind, new Map(entries));
  }
  for (const [namespace, entries] of Object.entries(saved.correlations || {})) {
    correlationMaps.set(namespace, new Map(entries));
  }
}

function placeholder(kind, value) {
  let values = placeholderMaps.get(kind);
  if (!values) {
    values = new Map();
    placeholderMaps.set(kind, values);
  }
  if (!values.has(value)) values.set(value, `<${kind}_${values.size + 1}>`);
  return values.get(value);
}

function exactStringFingerprint(value) {
  return `sha256:${createHash("sha256").update(`string:${value}`).digest("hex")}`;
}

function remapJsonRpcId(namespace, value) {
  return remapCorrelation(namespace, jsonRpcIdLabel, value);
}

function remapCorrelation(namespace, label, value) {
  const mapNamespace = `${namespace}:${label}`;
  let values = correlationMaps.get(mapNamespace);
  if (!values) {
    values = new Map();
    correlationMaps.set(mapNamespace, values);
  }
  const typed = `${typeof value}:${String(value)}`;
  if (!values.has(typed)) values.set(typed, values.size + 1);
  const mapped = values.get(typed);
  return typeof value === "number" ? mapped : `<${label}_${mapped}>`;
}

function redactMetadata(value, key) {
  if (typeof value === "string") {
    if (key === "monoNs") return "0";
    if (allowedMetadataValues.has(key)) {
      if (!allowedMetadataValues.get(key).has(value)) {
        throw new Error(`metadata value is outside reviewed exact set: ${key}`);
      }
      return value;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((child) => redactMetadata(child, key)).filter((child) => child !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => allowedMetadataKeys.has(childKey))
      .map(([childKey, child]) => [childKey, redactMetadata(child, childKey)])
      .filter(([, child]) => child !== undefined));
  }
  if (typeof value === "number") return key === "seq" ? value : 0;
  if (typeof value === "boolean") return allowedMetadataValues.get(key)?.has(value)
    ? value
    : undefined;
  return value;
}

const nativeSensitiveKeys = new Map([
  ["access_token", "TOKEN"], ["refresh_token", "TOKEN"], ["token", "TOKEN"],
  ["secret", "SECRET"], ["authorization", "BEARER"], ["serverKey", "SECRET"],
  ["account", "ACCOUNT"], ["email", "ACCOUNT"], ["username", "ACCOUNT_ID"],
  ["client_type", "CLIENT_TYPE"], ["clientType", "CLIENT_TYPE"],
  ["cwd", "PATH"], ["path", "PATH"], ["filePath", "PATH"],
  ["command", "COMMAND"], ["arguments", "BODY"], ["arguments_delta", "BODY"],
  ["args", "BODY"],
  ["tool_result", "BODY"], ["toolResult", "BODY"],
  ["content", "BODY"], ["text", "BODY"], ["prompt", "BODY"],
  ["rawInput", "BODY"], ["title", "BODY"],
  ["reasoning", "REASONING"], ["encrypted_content", "REASONING"],
  ["encryptedContent", "REASONING"],
  ["sessionId", "SESSION"], ["promptId", "PROMPT_ID"],
  ["requestId", "REQUEST_ID"], ["eventId", "EVENT_ID"],
  ["toolCallId", "TOOL_CALL_ID"], ["tool_call_id", "TOOL_CALL_ID"],
  ["agentId", "AGENT_ID"], ["agentInstanceId", "AGENT_INSTANCE_ID"],
  ["agentName", "AGENT_NAME"], ["hostname", "HOST"], ["hostName", "HOST"],
  ["team_id", "TEAM_ID"], ["teamId", "TEAM_ID"],
  ["team_name", "TEAM_NAME"], ["teamName", "TEAM_NAME"],
  ["nodeId", "NODE_ID"], ["node_id", "NODE_ID"],
  ["userId", "USER_ID"], ["user_id", "USER_ID"],
  ["accountId", "ACCOUNT_ID"], ["account_id", "ACCOUNT_ID"],
  ["machineId", "MACHINE_ID"], ["machine_id", "MACHINE_ID"],
  ["currentWorkingDirectory", "PATH"], ["gitRoot", "PATH"],
  ["argv", "COMMAND"], ["commandLine", "COMMAND"], ["command_line", "COMMAND"],
  ["executable", "COMMAND"], ["slash_command", "COMMAND"],
  ["availableCommands", "COMMAND"], ["clientCommands", "COMMAND"],
  ["user", "ACCOUNT"], ["input", "BODY"], ["output", "BODY"], ["body", "BODY"],
  ["password", "TOKEN"], ["apiKey", "TOKEN"], ["api_key", "TOKEN"],
  ["cookie", "TOKEN"], ["sid", "SESSION"],
  ["filter_session_id", "SESSION"], ["filterSessionId", "SESSION"],
  ["runningPromptId", "PROMPT_ID"], ["running_prompt_id", "PROMPT_ID"],
  ["session_summary", "BODY"], ["sessionSummary", "BODY"],
  ["prompts", "BODY"], ["message", "BODY"],
  ["log", "BODY"], ["logs", "BODY"], ["history", "BODY"],
  ["billing", "BILLING"],
]);
const structuralKeys = new Set([
  "type", "kind", "role", "method", "jsonrpc", "status", "outcome",
  "stopReason", "stop_reason", "sessionUpdate", "session_update",
  "updateType", "update_type", "mode", "severity",
]);
const normalizedSensitiveKeys = new Map(
  [...nativeSensitiveKeys].map(([key, kind]) => [key.replace(/[_.-]/g, "").toLowerCase(), kind]),
);

function preservedProtocolString(key, value) {
  if (key === "jsonrpc" && value === "2.0") return value;
  if (key === "method" && allowedMethods.has(value)) return value;
  if (requiredEnumValues.get(key)?.has(value)) return value;
  return undefined;
}

function pathAllowed(path, reviewedPaths) {
  if (!reviewedPaths) return true;
  if (reviewedPaths.has(path)) return true;
  const objectPrefix = `${path}.`;
  const arrayPrefix = `${path}[]`;
  return [...reviewedPaths].some((candidate) =>
    candidate.startsWith(objectPrefix) || candidate.startsWith(arrayPrefix));
}

function classifyKey(key) {
  if (!key) return undefined;
  const exact = nativeSensitiveKeys.get(key);
  if (exact) return exact;
  const normalized = key.replace(/[_.-]/g, "").toLowerCase();
  const normalizedExact = normalizedSensitiveKeys.get(normalized);
  if (normalizedExact) return normalizedExact;
  if (correlationLabelsByKey.has(key)) return `CORRELATION:${correlationLabelsByKey.get(key)}`;
  if (/^(?:agent|agentinstance|machine|node)(?:id|name)$/.test(normalized)) return "IDENTITY_ID";
  if (/^(?:user|account)(?:id|name)$/.test(normalized)) return "ACCOUNT_ID";
  if (/^host(?:name|id)?$/.test(normalized)) return "HOST";
  if (/^team(?:id|name)$/.test(normalized)) return "TEAM_ID";
  if (/^(?:argv|commandline|executable)$/.test(normalized)) return "COMMAND";
  if (/(?:cwd|workingdirectory|filepath)$/.test(normalized)) return "PATH";
  return undefined;
}

function sanitizeStructured(
  value,
  key,
  inheritedKind,
  correlationNamespace,
  reviewedPaths,
  currentPath = "",
  reviewedEnums,
  opaqueMode = false,
) {
  const directKind = classifyKey(key);
  const contextKind = directKind || inheritedKind;
  if (directKind?.startsWith("CORRELATION:")
    && (typeof value === "number" || typeof value === "string")) {
    const label = directKind.slice("CORRELATION:".length);
    return remapCorrelation(correlationNamespace, label, value);
  }
  if (typeof value === "string") {
    if (directKind) return placeholder(directKind, value);
    if (reviewedEnums?.has(currentPath)) {
      const persisted = exactHashedScalarPaths.has(currentPath)
        ? exactStringFingerprint(value)
        : value;
      if (!reviewedEnums.get(currentPath).has(persisted)) {
        throw new Error(`enum value is outside reviewed exact shape: ${currentPath}`);
      }
      return persisted;
    }
    if (key === "method") {
      if (!allowedMethods.has(value)) throw new Error("method is outside reviewed exact set");
      return value;
    }
    if (!reviewedEnums
      && requiredEnumValues.has(key)
      && !requiredEnumValues.get(key).has(value)) {
      throw new Error(`enum value is outside reviewed exact set: ${key}`);
    }
    const protocolValue = preservedProtocolString(key, value);
    if (protocolValue !== undefined) return protocolValue;
    if (contextKind) return placeholder(contextKind, value);
    return placeholder("STRING", value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const itemPath = `${currentPath}[]`;
    if (!pathAllowed(itemPath, reviewedPaths)) {
      if (reviewedPaths) throw new Error(`field path is outside reviewed live schema: ${itemPath}`);
      return [];
    }
    return value.map((child) => sanitizeStructured(
      child,
      undefined,
      contextKind,
      correlationNamespace,
      reviewedPaths,
      itemPath,
      reviewedEnums,
      reviewedEnums !== undefined
        && (opaqueMode || exactOpaqueSubtreeKeys.has(key)),
    ));
  }
  if (value && typeof value === "object") {
    const safeEntries = [];
    const childOpaqueMode = reviewedEnums !== undefined
      && (opaqueMode || exactOpaqueSubtreeKeys.has(key));
    for (const [childKey, child] of Object.entries(value)) {
      if (childOpaqueMode && !exactOpaqueStructuralKeys.has(childKey)) continue;
      const childPath = currentPath ? `${currentPath}.${childKey}` : childKey;
      if (!allowedJsonFields.has(childKey)) {
        if (reviewedPaths) {
          throw new Error(`field name is outside reviewed exact set: ${childPath}`);
        }
        continue;
      }
      if (!pathAllowed(childPath, reviewedPaths)) {
        if (reviewedPaths) {
          throw new Error(`field path is outside reviewed live schema: ${childPath}`);
        }
        continue;
      }
      safeEntries.push([
        childKey,
        sanitizeStructured(
          child,
          childKey,
          structuralKeys.has(childKey) && !(childKey === "name" && contextKind)
            ? undefined
            : contextKind,
          correlationNamespace,
          reviewedPaths,
          childPath,
          reviewedEnums,
          childOpaqueMode,
        ),
      ]);
    }
    return Object.fromEntries(safeEntries);
  }
  if (typeof value === "number") {
    if (reviewedEnums?.has(currentPath)) {
      if (!reviewedEnums.get(currentPath).has(value)) {
        throw new Error(`scalar value is outside reviewed exact shape: ${currentPath}`);
      }
      return value;
    }
    return 0;
  }
  if (typeof value === "boolean") {
    if (reviewedEnums?.has(currentPath)) {
      if (!reviewedEnums.get(currentPath).has(value)) {
        throw new Error(`scalar value is outside reviewed exact shape: ${currentPath}`);
      }
      return value;
    }
    return false;
  }
  return value;
}

function methodPayloadKind(method) {
  if (typeof method !== "string") return undefined;
  const normalized = method.toLowerCase();
  if (normalized.includes("billing")) return "BILLING";
  if (normalized.includes("log") || normalized.includes("history")) return "BODY";
  return undefined;
}

function typedId(value) {
  return `${typeof value}:${String(value)}`;
}

function sourceSide(direction) {
  const clientSource = new Set([
    "acp-submitter_to_gateway",
    "client_to_gateway",
    "client_to_grok",
    "client_to_serve",
    "gateway_to_leader",
    "gateway_to_tap",
    "real-tui_to_gateway",
    "tap_to_real_leader",
    "tui_to_gateway",
  ]);
  const serverSource = new Set([
    "gateway_to_acp-submitter",
    "gateway_to_client",
    "gateway_to_real-tui",
    "gateway_to_tui",
    "grok_to_client",
    "leader_to_gateway",
    "real_leader_to_tap",
    "serve_to_client",
    "tap_to_gateway",
  ]);
  if (clientSource.has(direction)) return "client";
  if (serverSource.has(direction)) return "server";
  return undefined;
}

function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function collectExactObservedShape(outer, rpc) {
  const paths = new Map();
  const enums = new Map();
  const record = (value, path) => {
    const type = jsonValueType(value);
    if (!["array", "boolean", "null", "number", "object", "string"].includes(type)) {
      throw new Error(`live protocol value has unsupported JSON type: ${path}`);
    }
    if (!paths.has(path)) paths.set(path, new Set());
    paths.get(path).add(type);
    if (["string", "number", "boolean"].includes(type) && exactEnumPaths.has(path)) {
      if (!enums.has(path)) enums.set(path, new Set());
      enums.get(path).add(type === "string" && exactHashedScalarPaths.has(path)
        ? exactStringFingerprint(value)
        : value);
    }
    return type;
  };
  const visit = (value, path, key, opaqueMode = false) => {
    const type = record(value, path);
    const childOpaqueMode = opaqueMode || exactOpaqueSubtreeKeys.has(key);
    if (type === "array") {
      for (const child of value) visit(child, `${path}[]`, undefined, childOpaqueMode);
      return;
    }
    if (type !== "object") return;
    for (const childKey of Object.keys(value).sort()) {
      if (childOpaqueMode && !exactOpaqueStructuralKeys.has(childKey)) continue;
      visit(value[childKey], `${path}.${childKey}`, childKey, childOpaqueMode);
    }
  };
  if (outer !== undefined) visit(outer, "$outer", undefined);
  if (rpc !== undefined) visit(rpc, "$rpc", undefined);
  return {
    paths: [...paths]
      .flatMap(([path, types]) => [...types].map((type) => ({ path, type })))
      .sort((left, right) => left.path.localeCompare(right.path)
        || left.type.localeCompare(right.type)),
    enums: [...enums]
      .map(([path, values]) => ({ path, values: [...values].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function correlatedResponseMethod(message, context) {
  const side = sourceSide(context.direction);
  if (!side || !Object.prototype.hasOwnProperty.call(message, "id")) {
    throw new Error("response has no reviewed origin side or id");
  }
  const requestSide = side === "client" ? "server" : "client";
  const key = [
    context.capture,
    context.connection,
    requestSide,
    typedId(message.id),
  ].join("\u0000");
  const methods = rawRequestMethods.get(key);
  if (!methods || methods.size !== 1) {
    throw new Error("response request correlation is missing or ambiguous");
  }
  return [...methods][0];
}

function describeRpc(message, context) {
  if (typeof message?.method === "string") {
    if (!allowedMethods.has(message.method)) throw new Error("method is outside reviewed exact set");
    return {
      messageKind: Object.prototype.hasOwnProperty.call(message, "id")
        ? "request"
        : "notification",
      method: message.method,
    };
  }
  if (message && typeof message === "object"
    && !Array.isArray(message)
    && Object.prototype.hasOwnProperty.call(message, "id")
    && (Object.prototype.hasOwnProperty.call(message, "result")
      || Object.prototype.hasOwnProperty.call(message, "error"))) {
    return {
      messageKind: "response",
      method: correlatedResponseMethod(message, context),
    };
  }
  throw new Error("JSON-RPC shape has neither reviewed method nor response");
}

function pathsForRoot(shape, root) {
  const prefix = `${root}.`;
  return new Set(shape.paths
    .filter(({ path }) => path.startsWith(prefix))
    .map(({ path }) => path.slice(prefix.length)));
}

function enumsForRoot(shape, root) {
  const prefix = `${root}.`;
  return new Map(shape.enums
    .filter(({ path }) => path.startsWith(prefix))
    .map(({ path, values }) => [path.slice(prefix.length), new Set(values)]));
}

function matchExactLiveShape(outer, rpc, context) {
  const descriptor = rpc === undefined
    ? { messageKind: "outer-message" }
    : describeRpc(rpc, context);
  const selector = {
    transport: context.transport,
    outerType: outer === undefined ? "not-applicable" : outer?.type,
    messageKind: descriptor.messageKind,
    ...(descriptor.method === undefined ? {} : { method: descriptor.method }),
  };
  if (livePolicyState.mode === "candidate") {
    const scopedSelector = { ...selector, direction: context.direction };
    if (!liveFixtureBinding?.allowedSelectorSha256.includes(
      candidateSelectorSha256(scopedSelector),
    )) {
      throw new Error(
        `live message selector is outside capture-scoped candidate seed: ${canonicalSelector(selector)}`,
      );
    }
  }
  const candidates = exactShapeSelectors.get(canonicalSelector(selector));
  if (!candidates) {
    throw new Error(
      `live message selector is outside reviewed exact set: ${canonicalSelector(selector)}`,
    );
  }
  const observed = collectExactObservedShape(outer, rpc);
  const pathSignature = canonicalPaths(observed.paths);
  const enumSignature = canonicalEnums(observed.enums);
  const matched = candidates.find((candidate) =>
    candidate.pathSignature === pathSignature && candidate.enumSignature === enumSignature);
  if (!matched) {
    const samePathCandidates = candidates.filter((candidate) =>
      candidate.pathSignature === pathSignature);
    const mismatchKind = samePathCandidates.length > 0 ? "scalar" : "shape";
    const scalarPathSuffix = mismatchKind === "scalar"
      ? (() => {
        const observedByPath = new Map(observed.enums.map(({ path, values }) => [
          path,
          JSON.stringify(values),
        ]));
        const mismatchedPaths = new Set();
        for (const candidate of samePathCandidates) {
          const candidateByPath = new Map(candidate.enums.map(({ path, values }) => [
            path,
            JSON.stringify(values),
          ]));
          for (const path of new Set([...observedByPath.keys(), ...candidateByPath.keys()])) {
            if (observedByPath.get(path) !== candidateByPath.get(path)) mismatchedPaths.add(path);
          }
        }
        return ` (paths=${[...mismatchedPaths].sort().join(",")})`;
      })()
      : "";
    throw new Error(
      `live message ${mismatchKind} is outside reviewed exact set: ${canonicalSelector(selector)}`
        + scalarPathSuffix,
    );
  }
  return {
    outerPaths: pathsForRoot(matched, "$outer"),
    outerEnums: enumsForRoot(matched, "$outer"),
    rpcPaths: pathsForRoot(matched, "$rpc"),
    rpcEnums: enumsForRoot(matched, "$rpc"),
  };
}

function legacyRpcReviewedPaths(message, context) {
  if (!context.liveCapture) return undefined;
  if (typeof message.method === "string") {
    if (!allowedMethods.has(message.method)) throw new Error("method is outside reviewed exact set");
    return new Set([
      ...livePathPolicy.rpcCommon,
      ...(livePathPolicy.rpcByMethod[message.method] || []),
    ]);
  }
  if (Object.prototype.hasOwnProperty.call(message, "result")
    || Object.prototype.hasOwnProperty.call(message, "error")) {
    const method = correlatedResponseMethod(message, context);
    const methodPaths = livePathPolicy.rpcResponseByMethod[method];
    if (!Array.isArray(methodPaths)) {
      throw new Error("response method has no reviewed exact schema");
    }
    return new Set([...livePathPolicy.rpcResponseCommon, ...methodPaths]);
  }
  throw new Error("JSON-RPC shape has neither reviewed method nor response");
}

function sanitizeJsonRpcMessage(message, correlationNamespace, context) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("JSON-RPC payload is not an object");
  }
  const exactShape = context.exactShape
    || (context.liveCapture && exactLiveTransports.has(context.transport)
      ? matchExactLiveShape(undefined, message, context)
      : undefined);
  const safe = sanitizeStructured(
    message,
    undefined,
    methodPayloadKind(message.method),
    correlationNamespace,
    exactShape?.rpcPaths || legacyRpcReviewedPaths(message, context),
    "",
    exactShape?.rpcEnums,
  );
  if (Object.prototype.hasOwnProperty.call(message, "id")
    && (typeof message.id === "number" || typeof message.id === "string")) {
    safe.id = remapJsonRpcId(`${correlationNamespace}:jsonrpc`, message.id);
  }
  return safe;
}

function sanitizeNativeOuter(outer, correlationNamespace, context) {
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    throw new Error("native outer payload is not an object");
  }
  let inner;
  let stringPayload = false;
  if (outer.type === "acp") {
    if (typeof outer.payload === "string") {
      inner = JSON.parse(outer.payload);
      stringPayload = true;
    } else if (outer.payload && typeof outer.payload === "object") {
      inner = outer.payload;
    } else {
      throw new Error("native acp payload has no parseable inner JSON-RPC value");
    }
  }
  const exactShape = context.liveCapture && exactLiveTransports.has(context.transport)
    ? matchExactLiveShape(outer, inner, context)
    : undefined;
  const outerForSanitization = outer.type === "acp"
    ? Object.fromEntries(Object.entries(outer).filter(([key]) => key !== "payload"))
    : outer;
  const legacyOuterPaths = context.liveCapture
    ? livePathPolicy.nativeOuterByType[outer.type]
    : undefined;
  if (context.liveCapture && !exactShape && !Array.isArray(legacyOuterPaths)) {
    throw new Error("native outer type is outside reviewed exact set");
  }
  const safeOuter = sanitizeStructured(
    outerForSanitization,
    undefined,
    undefined,
    correlationNamespace,
    exactShape?.outerPaths || (legacyOuterPaths ? new Set(legacyOuterPaths) : undefined),
    "",
    exactShape?.outerEnums,
  );
  if (outer.type !== "acp") return safeOuter;
  const safeInner = sanitizeJsonRpcMessage(inner, correlationNamespace, {
    ...context,
    exactShape,
  });
  safeOuter.payload = stringPayload ? JSON.stringify(safeInner) : safeInner;
  return safeOuter;
}

function sanitizeNativeStream(buffer, boundaryOffsets, correlationNamespace, context) {
  const SAFETY_MAX_FRAME_BYTES = 1024 * 1024;
  const output = [];
  const segments = [];
  let cursor = 0;
  let outputOffset = 0;
  let omittedUnsafeTail = false;

  const appendSegment = (sourceStart, sourceEnd, safeBytes) => {
    output.push(safeBytes);
    segments.push({
      sourceStart,
      sourceEnd,
      outputStart: outputOffset,
      outputEnd: outputOffset + safeBytes.length,
    });
    outputOffset += safeBytes.length;
  };

  while (cursor < buffer.length) {
    const frameStart = cursor;
    if (buffer.length - cursor < 4) {
      appendSegment(cursor, buffer.length, Buffer.alloc(buffer.length - cursor));
      omittedUnsafeTail = true;
      cursor = buffer.length;
      break;
    }
    const advertisedLength = buffer.readUInt32BE(cursor);
    cursor += 4;
    if (advertisedLength > SAFETY_MAX_FRAME_BYTES || buffer.length - cursor < advertisedLength) {
      const header = buffer.subarray(frameStart, frameStart + 4);
      const tail = Buffer.alloc(buffer.length - cursor);
      appendSegment(frameStart, buffer.length, Buffer.concat([header, tail]));
      omittedUnsafeTail = true;
      cursor = buffer.length;
      break;
    }
    const payload = buffer.subarray(cursor, cursor + advertisedLength);
    cursor += advertisedLength;
    let safePayload;
    let outer;
    try {
      outer = JSON.parse(payload.toString("utf8"));
    } catch {
      // A complete but unparseable native frame cannot be safely searched for
      // nested account/body fields. Retain framing and byte-count shape only.
      safePayload = Buffer.alloc(payload.length);
      omittedUnsafeTail = true;
    }
    if (outer !== undefined) {
      safePayload = Buffer.from(JSON.stringify(sanitizeNativeOuter(
        outer,
        correlationNamespace,
        context,
      )));
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(safePayload.length);
    appendSegment(frameStart, cursor, Buffer.concat([header, safePayload]));
  }

  const safe = Buffer.concat(output);
  const mapped = boundaryOffsets.map((position) => {
    for (const segment of segments) {
      if (position <= segment.sourceStart) return segment.outputStart;
      if (position <= segment.sourceEnd) {
        const sourceLength = Math.max(1, segment.sourceEnd - segment.sourceStart);
        const outputLength = segment.outputEnd - segment.outputStart;
        const ratio = (position - segment.sourceStart) / sourceLength;
        return segment.outputStart + Math.floor(ratio * outputLength);
      }
    }
    return safe.length;
  });
  return { bytes: safe, mapped, omittedUnsafeTail };
}

function mapTransformationSegments(segments, boundaryOffsets, outputLength) {
  return boundaryOffsets.map((position) => {
    for (const segment of segments) {
      if (position <= segment.sourceStart) return segment.outputStart;
      if (position <= segment.sourceEnd) {
        const sourceLength = Math.max(1, segment.sourceEnd - segment.sourceStart);
        const transformedLength = segment.outputEnd - segment.outputStart;
        const ratio = (position - segment.sourceStart) / sourceLength;
        return segment.outputStart + Math.floor(ratio * transformedLength);
      }
    }
    return outputLength;
  });
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(reviewed)) {
    throw new Error(`${label} fields are outside reviewed exact schema`);
  }
}

function validatePolicyRequestRef(value, label) {
  requireExactKeys(value, policyRequestRefFields, label);
  if (typeof value.connection !== "string"
    || !policyRequestRefConnections.has(value.connection)) {
    throw new Error(`${label}.connection is outside reviewed exact set`);
  }
  if (!Number.isSafeInteger(value.permissionOrdinal) || value.permissionOrdinal <= 0) {
    throw new Error(`${label}.permissionOrdinal must be a positive safe integer`);
  }
  return {
    connection: value.connection,
    permissionOrdinal: value.permissionOrdinal,
  };
}

function sanitizePolicyMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("policy IPC payload must be an object");
  }
  if (typeof message.type !== "string" || !policyMessageFields.has(message.type)) {
    throw new Error("policy IPC message type is outside reviewed exact set");
  }
  requireExactKeys(message, policyMessageFields.get(message.type), `policy.${message.type}`);
  if (typeof message.scenario !== "string" || !policyScenarios.has(message.scenario)) {
    throw new Error(`policy.${message.type}.scenario is outside reviewed exact set`);
  }

  if (message.type === "open") {
    return { type: message.type, scenario: message.scenario };
  }
  if (!Number.isSafeInteger(message.generation) || message.generation <= 0) {
    throw new Error(`policy.${message.type}.generation must be a positive safe integer`);
  }
  if (message.type === "bind") {
    const ownerRef = validatePolicyRequestRef(message.ownerRef, "policy.bind.ownerRef");
    const passiveRef = validatePolicyRequestRef(message.passiveRef, "policy.bind.passiveRef");
    const expectedOwnerConnection = message.scenario === "primary"
      ? "policy-owner-acp-1"
      : "disconnect-owner-acp-1";
    if (ownerRef.connection !== expectedOwnerConnection
      || passiveRef.connection !== "passive-acp-1") {
      throw new Error("policy.bind request refs do not match the reviewed scenario topology");
    }
    return {
      type: message.type,
      scenario: message.scenario,
      generation: message.generation,
      ownerRef,
      passiveRef,
    };
  }

  const requestRef = validatePolicyRequestRef(
    message.requestRef,
    `policy.${message.type}.requestRef`,
  );
  const safe = {
    type: message.type,
    scenario: message.scenario,
    generation: message.generation,
    requestRef,
  };
  if (message.type === "candidate") {
    if (typeof message.action !== "string" || !policyActions.has(message.action)) {
      throw new Error("policy.candidate.action is outside reviewed exact set");
    }
    safe.action = message.action;
  } else if (message.type === "decision") {
    if (typeof message.decision !== "string" || !policyDecisions.has(message.decision)) {
      throw new Error("policy.decision.decision is outside reviewed exact set");
    }
    safe.decision = message.decision;
  } else if (message.type === "window_close") {
    if (!Number.isSafeInteger(message.leaderResponseDelta)
      || !policyLeaderResponseDeltas.has(message.leaderResponseDelta)) {
      throw new Error("policy.window_close.leaderResponseDelta is outside reviewed exact set");
    }
    safe.leaderResponseDelta = message.leaderResponseDelta;
  }
  return safe;
}

function sanitizePolicyJsonLineStream(buffer, boundaryOffsets) {
  const outputs = [];
  const segments = [];
  let cursor = 0;
  let outputOffset = 0;
  const append = (sourceStart, sourceEnd, bytes) => {
    outputs.push(bytes);
    segments.push({
      sourceStart,
      sourceEnd,
      outputStart: outputOffset,
      outputEnd: outputOffset + bytes.length,
    });
    outputOffset += bytes.length;
  };
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) {
      throw new Error("policy IPC requires newline-terminated JSON messages");
    }
    const sourceEnd = newline + 1;
    const payload = buffer.subarray(cursor, newline);
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new Error("policy IPC contains invalid JSON");
    }
    const safe = Buffer.from(`${JSON.stringify(sanitizePolicyMessage(message))}\n`);
    append(cursor, sourceEnd, safe);
    cursor = sourceEnd;
  }
  const bytes = Buffer.concat(outputs);
  return {
    bytes,
    mapped: mapTransformationSegments(segments, boundaryOffsets, bytes.length),
    omittedUnsafeTail: false,
  };
}

function sanitizeJsonLineStream(buffer, boundaryOffsets, correlationNamespace, context) {
  const outputs = [];
  const segments = [];
  let cursor = 0;
  let outputOffset = 0;
  let omittedUnsafeTail = false;
  const append = (sourceStart, sourceEnd, bytes) => {
    outputs.push(bytes);
    segments.push({
      sourceStart,
      sourceEnd,
      outputStart: outputOffset,
      outputEnd: outputOffset + bytes.length,
    });
    outputOffset += bytes.length;
  };
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline < 0) {
      append(cursor, buffer.length, Buffer.alloc(buffer.length - cursor));
      omittedUnsafeTail = true;
      cursor = buffer.length;
      break;
    }
    const sourceEnd = newline + 1;
    const payload = buffer.subarray(cursor, newline);
    let safe;
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      safe = Buffer.concat([Buffer.alloc(payload.length), Buffer.from("\n")]);
      omittedUnsafeTail = true;
    }
    if (message !== undefined) {
      safe = Buffer.from(`${JSON.stringify(sanitizeJsonRpcMessage(
        message,
        correlationNamespace,
        context,
      ))}\n`);
    }
    append(cursor, sourceEnd, safe);
    cursor = sourceEnd;
  }
  const bytes = Buffer.concat(outputs);
  return {
    bytes,
    mapped: mapTransformationSegments(segments, boundaryOffsets, bytes.length),
    omittedUnsafeTail,
  };
}

function sanitizeJsonMessageRecords(chunks, boundaryOffsets, correlationNamespace, context) {
  const outputs = [];
  const segments = [];
  let sourceOffset = 0;
  let outputOffset = 0;
  let omittedUnsafeTail = false;
  for (const chunk of chunks) {
    let safe;
    let message;
    try {
      message = JSON.parse(chunk.toString("utf8"));
    } catch {
      safe = Buffer.alloc(chunk.length);
      omittedUnsafeTail = true;
    }
    if (message !== undefined) {
      safe = Buffer.from(JSON.stringify(sanitizeJsonRpcMessage(
        message,
        correlationNamespace,
        context,
      )));
    }
    outputs.push(safe);
    segments.push({
      sourceStart: sourceOffset,
      sourceEnd: sourceOffset + chunk.length,
      outputStart: outputOffset,
      outputEnd: outputOffset + safe.length,
    });
    sourceOffset += chunk.length;
    outputOffset += safe.length;
  }
  const bytes = Buffer.concat(outputs);
  return {
    bytes,
    mapped: mapTransformationSegments(segments, boundaryOffsets, bytes.length),
    omittedUnsafeTail,
  };
}

function sanitizeOpaqueStream(buffer, boundaryOffsets) {
  return {
    bytes: Buffer.alloc(buffer.length),
    mapped: [...boundaryOffsets],
    omittedUnsafeTail: buffer.length > 0,
  };
}

function validatePolicyRecordMetadata(record) {
  for (const key of Object.keys(record)) {
    if (!allowedMetadataKeys.has(key)) {
      throw new Error(`policy IPC metadata field is outside reviewed exact schema: ${key}`);
    }
  }
  if (!policyControlConnections.has(record.connection)) {
    throw new Error("policy IPC metadata connection is outside reviewed exact set");
  }
  if (record.stream !== "socket") {
    throw new Error("policy IPC metadata stream must be socket");
  }
  if (record.direction !== "candidate_to_gateway"
    && record.direction !== "gateway_to_candidate") {
    throw new Error("policy IPC metadata direction is outside reviewed exact set");
  }
  if (record.role !== "policy-admission-gateway"
    && record.role !== "policy-candidate-driver") {
    throw new Error("policy IPC metadata role is outside reviewed exact set");
  }
}

const groups = new Map();
for (const record of records) {
  if (record.schema !== "grok-wire-byte-record/v1" || record.encoding !== "base64") {
    throw new Error("unsupported raw byte record");
  }
  if (record.transport === policyIpc.transport) validatePolicyRecordMetadata(record);
  const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

function rawMessages(streamRecords) {
  const ordered = [...streamRecords].sort((left, right) => left.seq - right.seq);
  const chunks = ordered.map((record) => Buffer.from(record.bytesBase64, "base64"));
  const transport = ordered[0]?.transport;
  const messages = [];
  if (transport === "leader-native-ipc") {
    const stream = Buffer.concat(chunks);
    let offset = 0;
    while (offset + 4 <= stream.length) {
      const length = stream.readUInt32BE(offset);
      if (length > 1024 * 1024 || offset + 4 + length > stream.length) break;
      try {
        const outer = JSON.parse(stream.subarray(offset + 4, offset + 4 + length).toString("utf8"));
        if (outer?.type === "acp") {
          const inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
          if (inner && typeof inner === "object") messages.push(inner);
        }
      } catch {
        // The sanitizer separately handles incomplete/opaque frames.
      }
      offset += 4 + length;
    }
  } else if (transport === "acp-stdio") {
    for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch {}
    }
  } else if (transport === "serve-websocket-acp") {
    for (const chunk of chunks) {
      try { messages.push(JSON.parse(chunk.toString("utf8"))); } catch {}
    }
  }
  return messages;
}

const rawRequestMethods = new Map();
for (const streamRecords of groups.values()) {
  if (streamRecords[0]?.capture === "harness-canary") continue;
  const side = sourceSide(streamRecords[0]?.direction);
  if (!side) continue;
  for (const message of rawMessages(streamRecords)) {
    if (typeof message?.method !== "string"
      || !Object.prototype.hasOwnProperty.call(message, "id")) continue;
    const key = [
      streamRecords[0].capture,
      streamRecords[0].connection,
      side,
      typedId(message.id),
    ].join("\u0000");
    if (!rawRequestMethods.has(key)) rawRequestMethods.set(key, new Set());
    rawRequestMethods.get(key).add(message.method);
  }
}

const sanitizedRecords = [];
for (const streamRecords of groups.values()) {
  streamRecords.sort((a, b) => a.seq - b.seq);
  const chunks = streamRecords.map((record) => Buffer.from(record.bytesBase64, "base64"));
  const offsets = [];
  let offset = 0;
  for (const chunk of chunks) {
    offset += chunk.length;
    offsets.push(offset);
  }
  const native = streamRecords[0]?.transport === "leader-native-ipc";
  const transport = streamRecords[0]?.transport;
  const liveCapture = streamRecords[0]?.capture !== "harness-canary";
  const context = {
    liveCapture,
    capture: streamRecords[0]?.capture,
    connection: streamRecords[0]?.connection,
    direction: streamRecords[0]?.direction,
    transport,
  };
  const correlationNamespace = `${streamRecords[0]?.capture}:${streamRecords[0]?.connection}`;
  const transformation = native
    ? sanitizeNativeStream(Buffer.concat(chunks), offsets, correlationNamespace, context)
    : transport === policyIpc.transport
      ? sanitizePolicyJsonLineStream(Buffer.concat(chunks), offsets)
      : transport === "acp-stdio"
      ? sanitizeJsonLineStream(Buffer.concat(chunks), offsets, correlationNamespace, context)
      : transport === "serve-websocket-acp"
        ? sanitizeJsonMessageRecords(chunks, offsets, correlationNamespace, context)
        : sanitizeOpaqueStream(Buffer.concat(chunks), offsets);
  const { bytes, mapped, omittedUnsafeTail = false } = transformation;
  let previous = 0;
  for (let index = 0; index < streamRecords.length; index += 1) {
    const record = streamRecords[index];
    const end = mapped[index];
    const safeBytes = bytes.subarray(previous, end);
    previous = end;
    const {
      bytesBase64: _raw,
      originalByteLength: _rawByteLength,
      ...metadata
    } = record;
    const safeMetadata = redactMetadata(metadata);
    sanitizedRecords.push({
      ...safeMetadata,
      // Approval-owner evidence must be independently reproducible from the
      // persisted safe bytes. Its raw byte length cannot be recovered after
      // tmpfs destruction, so do not persist that unverifiable metric.
      ...(record.capture === "live-approval-owner-matrix"
        ? {}
        : { originalByteLength: record.originalByteLength }),
      sanitizedByteLength: safeBytes.length,
      encoding: "base64",
      bytesBase64: safeBytes.toString("base64"),
      sanitizedBytesSha256: createHash("sha256").update(safeBytes).digest("hex"),
      sanitization: native
        ? "native-structural-allowlist-v2"
        : transport === policyIpc.transport
          ? "policy-exact-schema-v1"
          : transport === "acp-stdio" || transport === "serve-websocket-acp"
          ? "json-structural-allowlist-v2"
          : "opaque-body-omitted-v2",
      ...(native && omittedUnsafeTail ? { unsafeNativeTailOmitted: true } : {}),
    });
  }
}

sanitizedRecords.sort((a, b) => a.seq - b.seq);
writeFileSync(output, `${sanitizedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, {
  mode: 0o600,
});
if (mapPath) {
  writeFileSync(mapPath, `${JSON.stringify({
    placeholders: Object.fromEntries(
      [...placeholderMaps].map(([kind, values]) => [kind, [...values]]),
    ),
    correlations: Object.fromEntries(
      [...correlationMaps].map(([namespace, values]) => [namespace, [...values]]),
    ),
  })}\n`, { mode: 0o600 });
}
