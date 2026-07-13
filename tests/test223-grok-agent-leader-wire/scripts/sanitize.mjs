import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [input, output, mapPath] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: sanitize.mjs RAW_NDJSON SAFE_NDJSON [RAW_MAP]");
const protocolAllowlist = JSON.parse(readFileSync(
  new URL("../protocol-allowlist.json", import.meta.url),
  "utf8",
));
if (protocolAllowlist.schema !== "test223-protocol-allowlist/v1") {
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

const records = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
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
    if (allowedMetadataValues.get(key)?.has(value)) return value;
    return placeholder("META", value);
  }
  if (Array.isArray(value)) return value.map((child) => redactMetadata(child, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => allowedMetadataKeys.has(childKey))
      .map(([childKey, child]) => [childKey, redactMetadata(child, childKey)]));
  }
  if (typeof value === "number") return key === "seq" ? value : 0;
  if (typeof value === "boolean") return false;
  return value;
}

const nativeSensitiveKeys = new Map([
  ["access_token", "TOKEN"], ["refresh_token", "TOKEN"], ["token", "TOKEN"],
  ["secret", "SECRET"], ["authorization", "BEARER"], ["serverKey", "SECRET"],
  ["account", "ACCOUNT"], ["email", "ACCOUNT"], ["username", "ACCOUNT_ID"],
  ["cwd", "PATH"], ["path", "PATH"], ["filePath", "PATH"],
  ["command", "COMMAND"], ["arguments", "BODY"], ["args", "BODY"],
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

function sanitizeStructured(value, key, inheritedKind, correlationNamespace) {
  const directKind = classifyKey(key);
  const contextKind = directKind || inheritedKind;
  if (directKind?.startsWith("CORRELATION:")
    && (typeof value === "number" || typeof value === "string")) {
    const label = directKind.slice("CORRELATION:".length);
    return remapCorrelation(correlationNamespace, label, value);
  }
  if (typeof value === "string") {
    if (directKind) return placeholder(directKind, value);
    if (key === "method") {
      return allowedMethods.has(value) ? value : placeholder("METHOD", value);
    }
    const protocolValue = preservedProtocolString(key, value);
    if (protocolValue !== undefined) return protocolValue;
    if (contextKind) return placeholder(contextKind, value);
    return placeholder("STRING", value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeStructured(child, undefined, contextKind, correlationNamespace));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => allowedJsonFields.has(childKey))
      .map(([childKey, child]) => [
      childKey,
      sanitizeStructured(
        child,
        childKey,
        structuralKeys.has(childKey) && !(childKey === "name" && contextKind)
          ? undefined
          : contextKind,
        correlationNamespace,
      ),
    ]));
  }
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  return value;
}

function methodPayloadKind(method) {
  if (typeof method !== "string") return undefined;
  const normalized = method.toLowerCase();
  if (normalized.includes("billing")) return "BILLING";
  if (normalized.includes("log") || normalized.includes("history")) return "BODY";
  return undefined;
}

function sanitizeJsonRpcMessage(message, correlationNamespace) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("JSON-RPC payload is not an object");
  }
  const safe = sanitizeStructured(
    message,
    undefined,
    methodPayloadKind(message.method),
    correlationNamespace,
  );
  if (Object.prototype.hasOwnProperty.call(message, "id")
    && (typeof message.id === "number" || typeof message.id === "string")) {
    safe.id = remapJsonRpcId(`${correlationNamespace}:jsonrpc`, message.id);
  }
  return safe;
}

function sanitizeNativeOuter(outer, correlationNamespace) {
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    throw new Error("native outer payload is not an object");
  }
  const outerForSanitization = outer.type === "acp"
    ? Object.fromEntries(Object.entries(outer).filter(([key]) => key !== "payload"))
    : outer;
  const safeOuter = sanitizeStructured(
    outerForSanitization,
    undefined,
    undefined,
    correlationNamespace,
  );
  if (outer.type !== "acp") return safeOuter;
  let inner;
  let stringPayload = false;
  if (typeof outer.payload === "string") {
    inner = JSON.parse(outer.payload);
    stringPayload = true;
  } else if (outer.payload && typeof outer.payload === "object") {
    inner = outer.payload;
  } else {
    throw new Error("native acp payload has no parseable inner JSON-RPC value");
  }
  const safeInner = sanitizeJsonRpcMessage(inner, correlationNamespace);
  safeOuter.payload = stringPayload ? JSON.stringify(safeInner) : safeInner;
  return safeOuter;
}

function sanitizeNativeStream(buffer, boundaryOffsets, correlationNamespace) {
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
    try {
      const outer = JSON.parse(payload.toString("utf8"));
      safePayload = Buffer.from(JSON.stringify(sanitizeNativeOuter(outer, correlationNamespace)));
    } catch {
      // A complete but unparseable native frame cannot be safely searched for
      // nested account/body fields. Retain framing and byte-count shape only.
      safePayload = Buffer.alloc(payload.length);
      omittedUnsafeTail = true;
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

function sanitizeJsonLineStream(buffer, boundaryOffsets, correlationNamespace) {
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
    try {
      const message = JSON.parse(payload.toString("utf8"));
      safe = Buffer.from(`${JSON.stringify(sanitizeJsonRpcMessage(message, correlationNamespace))}\n`);
    } catch {
      safe = Buffer.concat([Buffer.alloc(payload.length), Buffer.from("\n")]);
      omittedUnsafeTail = true;
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

function sanitizeJsonMessageRecords(chunks, boundaryOffsets, correlationNamespace) {
  const outputs = [];
  const segments = [];
  let sourceOffset = 0;
  let outputOffset = 0;
  let omittedUnsafeTail = false;
  for (const chunk of chunks) {
    let safe;
    try {
      const message = JSON.parse(chunk.toString("utf8"));
      safe = Buffer.from(JSON.stringify(sanitizeJsonRpcMessage(message, correlationNamespace)));
    } catch {
      safe = Buffer.alloc(chunk.length);
      omittedUnsafeTail = true;
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

const groups = new Map();
for (const record of records) {
  if (record.schema !== "grok-wire-byte-record/v1" || record.encoding !== "base64") {
    throw new Error("unsupported raw byte record");
  }
  const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
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
  const correlationNamespace = `${streamRecords[0]?.capture}:${streamRecords[0]?.connection}`;
  const transformation = native
    ? sanitizeNativeStream(Buffer.concat(chunks), offsets, correlationNamespace)
    : transport === "acp-stdio"
      ? sanitizeJsonLineStream(Buffer.concat(chunks), offsets, correlationNamespace)
      : transport === "serve-websocket-acp"
        ? sanitizeJsonMessageRecords(chunks, offsets, correlationNamespace)
        : sanitizeOpaqueStream(Buffer.concat(chunks), offsets);
  const { bytes, mapped, omittedUnsafeTail = false } = transformation;
  let previous = 0;
  for (let index = 0; index < streamRecords.length; index += 1) {
    const record = streamRecords[index];
    const end = mapped[index];
    const safeBytes = bytes.subarray(previous, end);
    previous = end;
    const { bytesBase64: _raw, ...metadata } = record;
    const safeMetadata = redactMetadata(metadata);
    sanitizedRecords.push({
      ...safeMetadata,
      originalByteLength: record.originalByteLength,
      sanitizedByteLength: safeBytes.length,
      encoding: "base64",
      bytesBase64: safeBytes.toString("base64"),
      sanitizedBytesSha256: createHash("sha256").update(safeBytes).digest("hex"),
      sanitization: native
        ? "native-structural-allowlist-v2"
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
