import {
  lstatSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const NATIVE_MAX_FRAME_BYTES = 1024 * 1024;
const SUPPORTED_TRANSPORTS = new Set(["leader-native-ipc", "acp-stdio"]);
const ENUM_KEYS = new Set([
  "type",
  "kind",
  "mode",
  "sessionUpdate",
  "session_update",
  "updateType",
  "update_type",
  "outcome",
  "role",
  "status",
  "stopReason",
  "stop_reason",
  "severity",
  "jsonrpc",
  "method",
]);
const REVIEWED_PROTOCOL = JSON.parse(readFileSync(
  new URL("../protocol-allowlist.json", import.meta.url),
  "utf8",
));
const REVIEWED_METHODS = new Set(REVIEWED_PROTOCOL.methods || []);
const REVIEWED_ENUMS = new Map(Object.entries(REVIEWED_PROTOCOL.enums || {})
  .map(([key, values]) => [key, new Set(values)]));
// Only these non-user protocol scalars may leave raw tmpfs verbatim in the
// structural summary.  The list is path-specific so an account/billing flag or
// a same-named field in another context is never exported accidentally.
const EXACT_SCALAR_PATHS = new Set([
  "$outer.capabilities.auto_mode",
  "$outer.capabilities.code_nav_enabled",
  "$outer.capabilities.fs_read",
  "$outer.capabilities.fs_write",
  "$outer.capabilities.terminal",
  "$outer.capabilities.yolo_mode",
  "$outer.leader_capabilities.control_v1",
  "$outer.leader_capabilities.relaunch_v1",
  "$outer.leader_capabilities.runtime_cpu_profile",
  "$outer.leader_capabilities.workspace_exposure",
  "$outer.leader_protocol_version",
  "$outer.ready",
  "$rpc.params.clientCapabilities._meta.x.ai/bashOutputNoColor",
  "$rpc.params.clientCapabilities._meta.x.ai/gitHeadChanged",
  "$rpc.params.clientCapabilities._meta.x.ai/incrementalBashOutput",
  "$rpc.params.clientCapabilities.fs.readTextFile",
  "$rpc.params.clientCapabilities.fs.writeTextFile",
  "$rpc.params.clientCapabilities.terminal",
  "$rpc.params.meta.headless",
  "$rpc.params.methodId",
  "$rpc.params.protocolVersion",
  "$rpc.result._meta.cancelRewind",
  "$rpc.result._meta.defaultAuthMethodId",
  "$rpc.result._meta.grokShell",
  "$rpc.result._meta.mcpApps",
  "$rpc.result._meta.sessionRecap",
  "$rpc.result._meta.x.ai/mcp/sdk",
  "$rpc.result._meta.x.ai/pluginDirs",
  "$rpc.result.agentCapabilities._meta.x.ai/fs_notify",
  "$rpc.result.agentCapabilities.loadSession",
  "$rpc.result.agentCapabilities.mcpCapabilities.http",
  "$rpc.result.agentCapabilities.mcpCapabilities.sse",
  "$rpc.result.agentCapabilities.promptCapabilities.audio",
  "$rpc.result.agentCapabilities.promptCapabilities.embeddedContext",
  "$rpc.result.agentCapabilities.promptCapabilities.image",
  "$rpc.result.authMethods[].id",
  "$rpc.result.protocolVersion",
]);
const stringFingerprint = (value) => `sha256:${createHash("sha256")
  .update(`string:${value}`)
  .digest("hex")}`;
const reviewedStringFingerprints = (values) => values.map(stringFingerprint);
const PRE_REVIEWED_SCALAR_VALUES = new Map([
  ["$outer.leader_protocol_version", new Set([1])],
  ["$rpc.params.methodId", new Set(reviewedStringFingerprints(["cached_token"]))],
  ["$rpc.params.protocolVersion", new Set([1, ...reviewedStringFingerprints(["1"])])],
  ["$rpc.result._meta.defaultAuthMethodId",
    new Set(reviewedStringFingerprints(["cached_token"]))],
  ["$rpc.result.authMethods[].id",
    new Set(reviewedStringFingerprints(["cached_token", "grok.com"]))],
  ["$rpc.result.protocolVersion", new Set([1, ...reviewedStringFingerprints(["1"])])],
]);
const VALUE_TYPES = new Set([
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
]);
const MESSAGE_KINDS = new Set([
  "notification",
  "outer-message",
  "request",
  "response",
  "unresolved",
]);
// These fields contain user/model/tool material or maps whose keys can be
// supplied by that material.  Their container remains visible to the shape
// review, but neither child keys nor child enum-looking strings may leave the
// raw tmpfs through this structural summary.
const OPAQUE_SUBTREE_KEYS = new Set([
  "access_token",
  "account",
  "apiKey",
  "api_key",
  "args",
  "arguments",
  "argv",
  "authorization",
  "availableCommands",
  "billing",
  "body",
  "clientCommands",
  "command",
  "commandLine",
  "command_line",
  "content",
  "cookie",
  "cwd",
  "encryptedContent",
  "encrypted_content",
  "email",
  "executable",
  "filePath",
  "gitRoot",
  "history",
  "input",
  "log",
  "logs",
  "message",
  "output",
  "password",
  "path",
  "payload",
  "prompt",
  "prompts",
  "rawInput",
  "reasoning",
  "refresh_token",
  "secret",
  "serverKey",
  "sessionSummary",
  "session_summary",
  "sid",
  "slash_command",
  "text",
  "title",
  "token",
  "toolResult",
  "tool_result",
  "user",
  "username",
]);
// Opaque protocol containers may still carry a small set of framing
// discriminants.  Keep only those names and their exact values; never emit
// arbitrary child names from a prompt/body/tool payload.  This lets the
// reviewed shape distinguish, for example, a text block from an unknown block
// kind without exporting the block text itself.
const OPAQUE_STRUCTURAL_KEYS = new Set([
  "jsonrpc",
  "kind",
  "method",
  "mode",
  "outcome",
  "role",
  "sessionUpdate",
  "session_update",
  "severity",
  "status",
  "stopReason",
  "stop_reason",
  "type",
  "updateType",
  "update_type",
]);

function fail(message) {
  throw new Error(message);
}

function assertRawInput(input) {
  const configuredRawDir = process.env.RAW_DIR;
  if (!configuredRawDir) fail("RAW_DIR is required");

  let rawDir;
  let inputPath;
  try {
    const rawDirInput = resolve(configuredRawDir);
    if (lstatSync(rawDirInput).isSymbolicLink()) fail("RAW_DIR must not be a symlink");
    rawDir = realpathSync(rawDirInput);
    const inputInput = resolve(input);
    const inputInfo = lstatSync(inputInput);
    if (inputInfo.isSymbolicLink() || !inputInfo.isFile()) {
      fail("raw input must be a regular non-symlink file");
    }
    inputPath = realpathSync(inputInput);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("raw input")) throw error;
    if (error instanceof Error && error.message.startsWith("RAW_DIR")) throw error;
    fail("raw input path validation failed");
  }

  const rel = relative(rawDir, inputPath);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    fail("raw input must be a file below RAW_DIR");
  }
  if (Number(statfsSync(rawDir).type) !== TMPFS_MAGIC
    || Number(statfsSync(inputPath).type) !== TMPFS_MAGIC) {
    fail("RAW_DIR and raw input must be on tmpfs");
  }
  return inputPath;
}

function decodeBase64(value) {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("raw record has invalid base64 bytes");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("raw record has non-canonical base64 bytes");
  return bytes;
}

function parseRecords(inputPath) {
  const text = readFileSync(inputPath, "utf8");
  const records = [];
  for (const [inputOrder, line] of text.split("\n").entries()) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail("raw input contains invalid NDJSON");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || record.schema !== "grok-wire-byte-record/v1") {
      fail("raw input contains an unsupported record");
    }
    if (!SUPPORTED_TRANSPORTS.has(record.transport)) continue;
    if (typeof record.capture !== "string"
      || typeof record.connection !== "string"
      || typeof record.stream !== "string"
      || typeof record.direction !== "string"
      || !Number.isSafeInteger(record.seq)) {
      fail("raw record metadata is incomplete");
    }
    records.push({
      capture: record.capture,
      connection: record.connection,
      stream: record.stream,
      direction: record.direction,
      transport: record.transport,
      seq: record.seq,
      inputOrder,
      bytes: decodeBase64(record.bytesBase64),
    });
  }
  return records;
}

function parseJson(bytes, errorMessage) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(errorMessage);
  }
}

function firstContributingOrder(chunks, start, end) {
  let offset = 0;
  let first;
  for (const chunk of chunks) {
    const chunkEnd = offset + chunk.bytes.length;
    if (start < chunkEnd && end > offset) {
      first = first === undefined ? chunk.inputOrder : Math.min(first, chunk.inputOrder);
    }
    offset = chunkEnd;
  }
  return first;
}

function parseNativeFrames(group, bytes, chunks) {
  const frames = [];
  let cursor = 0;
  while (bytes.length - cursor >= 4) {
    const start = cursor;
    const payloadLength = bytes.readUInt32BE(cursor);
    cursor += 4;
    if (payloadLength > NATIVE_MAX_FRAME_BYTES) fail("native frame exceeds safety maximum");
    if (bytes.length - cursor < payloadLength) break;
    const end = cursor + payloadLength;
    const outer = parseJson(bytes.subarray(cursor, end), "native frame contains invalid JSON");
    cursor = end;

    let rpc;
    if (outer && typeof outer === "object" && !Array.isArray(outer) && outer.type === "acp") {
      if (typeof outer.payload === "string") {
        rpc = parseJson(Buffer.from(outer.payload, "utf8"), "native ACP payload is invalid");
      } else if (outer.payload && typeof outer.payload === "object") {
        rpc = outer.payload;
      } else {
        fail("native ACP payload is invalid");
      }
    }
    frames.push({
      ...group,
      order: firstContributingOrder(chunks, start, end),
      outer,
      rpc,
    });
  }
  return frames;
}

function parseStdioFrames(group, bytes, chunks) {
  const frames = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const end = newline + 1;
    if (newline > start) {
      frames.push({
        ...group,
        order: firstContributingOrder(chunks, start, end),
        rpc: parseJson(bytes.subarray(start, newline), "ACP stdio frame contains invalid JSON"),
      });
    }
    start = end;
  }
  return frames;
}

function reconstructFrames(records) {
  const streamGroups = new Map();
  for (const record of records) {
    const key = JSON.stringify([
      record.capture,
      record.transport,
      record.connection,
      record.stream,
      record.direction,
    ]);
    if (!streamGroups.has(key)) {
      streamGroups.set(key, {
        capture: record.capture,
        transport: record.transport,
        connection: record.connection,
        stream: record.stream,
        direction: record.direction,
        records: [],
      });
    }
    streamGroups.get(key).records.push(record);
  }

  const frames = [];
  for (const group of streamGroups.values()) {
    const chunks = [...group.records]
      .sort((a, b) => a.seq - b.seq || a.inputOrder - b.inputOrder);
    const bytes = Buffer.concat(chunks.map((chunk) => chunk.bytes));
    const descriptor = {
      capture: group.capture,
      transport: group.transport,
      connection: group.connection,
      stream: group.stream,
      direction: group.direction,
    };
    frames.push(...(group.transport === "leader-native-ipc"
      ? parseNativeFrames(descriptor, bytes, chunks)
      : parseStdioFrames(descriptor, bytes, chunks)));
  }
  return frames.sort((a, b) => a.order - b.order);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function typedId(value) {
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${Object.is(value, -0) ? "-0" : JSON.stringify(value)}`;
  }
  return undefined;
}

function rpcKind(rpc) {
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) return "unresolved";
  if (typeof rpc.method === "string") return own(rpc, "id") ? "request" : "notification";
  if (own(rpc, "id") && (own(rpc, "result") || own(rpc, "error"))) return "response";
  return "unresolved";
}

function reverseDirection(direction) {
  const separator = "_to_";
  const split = direction.indexOf(separator);
  if (split <= 0 || split !== direction.lastIndexOf(separator)) return undefined;
  const source = direction.slice(0, split);
  const destination = direction.slice(split + separator.length);
  if (!source || !destination) return undefined;
  return `${destination}${separator}${source}`;
}

function requestKey(frame, direction, id) {
  return JSON.stringify([
    frame.capture,
    frame.transport,
    frame.connection,
    direction,
    id,
  ]);
}

function correlateResponses(frames) {
  const outstanding = new Map();
  for (const frame of frames) {
    frame.messageKind = frame.rpc === undefined ? "outer-message" : rpcKind(frame.rpc);
    if (frame.messageKind === "request") {
      const id = typedId(frame.rpc.id);
      if (id === undefined) {
        frame.messageKind = "unresolved";
        continue;
      }
      frame.correlatedMethod = frame.rpc.method;
      const key = requestKey(frame, frame.direction, id);
      if (!outstanding.has(key)) outstanding.set(key, []);
      outstanding.get(key).push(frame.rpc.method);
      continue;
    }
    if (frame.messageKind === "notification") {
      frame.correlatedMethod = frame.rpc.method;
      continue;
    }
    if (frame.messageKind !== "response") continue;
    const id = typedId(frame.rpc.id);
    const opposite = reverseDirection(frame.direction);
    if (id === undefined || opposite === undefined) {
      frame.correlatedMethod = "unresolved";
      continue;
    }
    const pending = outstanding.get(requestKey(frame, opposite, id));
    frame.correlatedMethod = pending?.shift() ?? "unresolved";
  }
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function collectShape(value, root) {
  const pathTypes = new Map();
  const enumValues = new Map();

  const record = (current, path, key) => {
    const type = valueType(current);
    if (!VALUE_TYPES.has(type)) fail("protocol value has an unsupported JSON type");
    if (!pathTypes.has(path)) pathTypes.set(path, new Set());
    pathTypes.get(path).add(type);
    if ((type === "string" && ENUM_KEYS.has(key))
      || (["string", "number", "boolean"].includes(type)
        && EXACT_SCALAR_PATHS.has(path))) {
      if (type === "string" && ENUM_KEYS.has(key)) {
        const reviewed = key === "method"
          ? REVIEWED_METHODS
          : key === "jsonrpc"
            ? new Set(["2.0"])
            : REVIEWED_ENUMS.get(key);
        if (!reviewed?.has(current)) {
          fail(`enum is outside the pre-reviewed set: ${path} (${stringFingerprint(current)})`);
        }
      }
      if (EXACT_SCALAR_PATHS.has(path) && type !== "boolean") {
        const evidenceValue = type === "string" ? stringFingerprint(current) : current;
        const reviewed = PRE_REVIEWED_SCALAR_VALUES.get(path);
        if (!reviewed?.has(evidenceValue)) {
          const fingerprint = createHash("sha256")
            .update(`${typeof current}:${String(current)}`)
            .digest("hex");
          fail(`exact scalar is outside the pre-reviewed set: ${path} (${fingerprint})`);
        }
      }
      if (!enumValues.has(path)) enumValues.set(path, new Set());
      enumValues.get(path).add(EXACT_SCALAR_PATHS.has(path) && type === "string"
        ? stringFingerprint(current)
        : current);
    }
    return type;
  };

  const visitOpaqueStructure = (current, path, key) => {
    const type = record(current, path, key);
    if (type === "array") {
      for (const child of current) visitOpaqueStructure(child, `${path}[]`, undefined);
      return;
    }
    if (type !== "object") return;
    for (const childKey of Object.keys(current).sort()) {
      if (!OPAQUE_STRUCTURAL_KEYS.has(childKey)) continue;
      visitOpaqueStructure(current[childKey], `${path}.${childKey}`, childKey);
    }
  };

  const visit = (current, path, key) => {
    if (OPAQUE_SUBTREE_KEYS.has(key)) {
      visitOpaqueStructure(current, path, key);
      return;
    }
    const type = record(current, path, key);
    if (type === "array") {
      for (const child of current) visit(child, `${path}[]`, undefined);
    } else if (type === "object") {
      for (const childKey of Object.keys(current).sort()) {
        visit(current[childKey], `${path}.${childKey}`, childKey);
      }
    }
  };

  visit(value, root, undefined);
  return {
    paths: [...pathTypes]
      .flatMap(([path, types]) => [...types].sort().map((type) => ({ path, type })))
      .sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type)),
    enums: [...enumValues]
      .map(([path, values]) => ({ path, values: [...values].sort() }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function mergeFrameShape(frame) {
  const pieces = [];
  if (frame.outer !== undefined) pieces.push(collectShape(frame.outer, "$outer"));
  if (frame.rpc !== undefined) pieces.push(collectShape(frame.rpc, "$rpc"));
  return {
    paths: pieces.flatMap((piece) => piece.paths)
      .sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type)),
    enums: pieces.flatMap((piece) => piece.enums)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function alphabeticLabel(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function opaqueLabels(frames, property, prefix, parentProperty) {
  const labels = new Map();
  for (const frame of frames) {
    const rawKey = parentProperty
      ? JSON.stringify([frame[parentProperty], frame[property]])
      : frame[property];
    if (!labels.has(rawKey)) labels.set(rawKey, `${prefix}-${alphabeticLabel(labels.size)}`);
  }
  return labels;
}

function buildSummary(frames) {
  correlateResponses(frames);
  const connectionLabels = opaqueLabels(frames, "connection", "connection", "capture");
  const directionLabels = opaqueLabels(frames, "direction", "direction", "connection");
  const groups = new Map();

  for (const frame of frames) {
    const connectionKey = JSON.stringify([frame.capture, frame.connection]);
    const directionKey = JSON.stringify([frame.connection, frame.direction]);
    const outerType = frame.transport === "acp-stdio"
      ? "not-applicable"
      : (typeof frame.outer?.type === "string" ? frame.outer.type : "unresolved");
    const selector = {
      transport: frame.transport,
      connection: connectionLabels.get(connectionKey),
      direction: directionLabels.get(directionKey),
      outerType,
      messageKind: frame.messageKind,
      ...(frame.messageKind === "request" || frame.messageKind === "notification"
        || frame.messageKind === "response"
        ? { method: frame.correlatedMethod ?? "unresolved" }
        : {}),
    };
    const key = JSON.stringify(selector);
    if (!groups.has(key)) groups.set(key, { selector, shapes: new Map() });
    const shape = mergeFrameShape(frame);
    groups.get(key).shapes.set(JSON.stringify(shape), shape);
  }

  return {
    schema: "grok-raw-structure-summary",
    groups: [...groups.values()]
      .map(({ selector, shapes }) => ({
        selector,
        shapes: [...shapes.values()].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }))
      .sort((a, b) => JSON.stringify(a.selector).localeCompare(JSON.stringify(b.selector))),
  };
}

function assertSafeSummary(summary) {
  const visit = (value, key) => {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      if (key === "values" && value !== null
        && (typeof value === "boolean" || Number.isFinite(value))) return;
      fail("summary unexpectedly contains a raw scalar value");
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      return;
    }
    if (typeof value !== "string") fail("summary contains an unsupported value");
    if (key === "transport" && !SUPPORTED_TRANSPORTS.has(value)) {
      fail("summary contains an unsupported transport");
    }
    if (key === "messageKind" && !MESSAGE_KINDS.has(value)) {
      fail("summary contains an unsupported message kind");
    }
    if ((key === "connection" && !/^connection-[a-z]+$/.test(value))
      || (key === "direction" && !/^direction-[a-z]+$/.test(value))) {
      fail("summary contains a non-opaque selector label");
    }
    if (key === "type" && !VALUE_TYPES.has(value)) {
      fail("summary contains an unsupported path type");
    }
  };
  visit(summary, undefined);
}

const argv = process.argv.slice(2);
if (argv.length !== 1) fail("usage: summarize-raw-structure.mjs RAW_BYTE_NDJSON");
const inputPath = assertRawInput(argv[0]);
let frames = reconstructFrames(parseRecords(inputPath));
if (process.env.SUMMARY_OUTER_TYPES) {
  const outerTypes = new Set(process.env.SUMMARY_OUTER_TYPES.split(",").filter(Boolean));
  if (outerTypes.size === 0
    || [...outerTypes].some((value) => !new Set(["ping", "pong"]).has(value))) {
    fail("SUMMARY_OUTER_TYPES contains an unsupported capture-only filter");
  }
  frames = frames.filter((frame) => outerTypes.has(frame.outer?.type));
  if (frames.length === 0) fail("capture contains no frame matching SUMMARY_OUTER_TYPES");
}
const summary = buildSummary(frames);
assertSafeSummary(summary);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
