const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class RpcOrderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RpcOrderError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new RpcOrderError(code, message);
}

/**
 * Return a collision-free comparison key for a JSON-RPC id.
 *
 * JSON-RPC permits string and number ids. Other values are rejected instead
 * of being coerced because coercion would make, for example, 7 and "7"
 * indistinguishable. Negative zero follows JavaScript/JSON equality and is
 * normalized to zero.
 */
export function jsonRpcIdKey(id) {
  if (typeof id === "string") return `string:${id.length}:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) {
    const normalized = Object.is(id, -0) ? 0 : id;
    return `number:${String(normalized)}`;
  }
  return reject(
    "UNSUPPORTED_JSON_RPC_ID",
    "JSON-RPC id must be a finite number or string",
  );
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    reject("INVALID_PROJECTION_LANE", `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Derive the capture-order coordinate mandated by the Phase 0 projection.
 */
export function projectionCoordinate(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return reject("INVALID_PROJECTION_ROW", "projection row must be an object");
  }
  if (!Array.isArray(row.recordSeqs) || row.recordSeqs.length === 0) {
    return reject(
      "INVALID_RECORD_SEQS",
      "projection row recordSeqs must be a non-empty array",
    );
  }
  const seen = new Set();
  let recordSeq = Number.POSITIVE_INFINITY;
  for (const seq of row.recordSeqs) {
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      return reject("INVALID_RECORD_SEQ", "recordSeqs entries must be positive safe integers");
    }
    if (seen.has(seq)) {
      return reject("DUPLICATE_RECORD_SEQ", "recordSeqs contains a duplicate sequence");
    }
    seen.add(seq);
    recordSeq = Math.min(recordSeq, seq);
  }
  if (!Number.isSafeInteger(row.frameIndex) || row.frameIndex <= 0) {
    return reject("INVALID_FRAME_INDEX", "frameIndex must be a positive safe integer");
  }
  return Object.freeze({ recordSeq, frameIndex: row.frameIndex });
}

export function projectionLaneKey(row) {
  return JSON.stringify([
    requireNonEmptyString(row.capture, "capture"),
    requireNonEmptyString(row.transport, "transport"),
    requireNonEmptyString(row.connection, "connection"),
    requireNonEmptyString(row.stream, "stream"),
    requireNonEmptyString(row.direction, "direction"),
  ]);
}

function defaultRowOf(entry) {
  return entry?.row ?? entry;
}

/**
 * Validate projection coordinates and return entries in wire-capture order.
 *
 * `frameIndex` is continuous within each capture/transport/connection/stream/
 * direction lane. Across lanes, `(min(recordSeqs), frameIndex)` is the sole
 * ordering coordinate and therefore must be unique.
 */
export function orderProjectionEntries(entries, { rowOf = defaultRowOf } = {}) {
  if (!Array.isArray(entries)) {
    return reject("INVALID_PROJECTION_ENTRIES", "projection entries must be an array");
  }
  if (typeof rowOf !== "function") {
    return reject("INVALID_ROW_ACCESSOR", "rowOf must be a function");
  }

  const annotated = [];
  const coordinateKeys = new Set();
  const lanes = new Map();

  for (const [inputIndex, entry] of entries.entries()) {
    const row = rowOf(entry);
    const coordinate = projectionCoordinate(row);
    const laneKey = projectionLaneKey(row);
    const coordinateKey = `${coordinate.recordSeq}:${coordinate.frameIndex}`;
    if (coordinateKeys.has(coordinateKey)) {
      return reject(
        "DUPLICATE_PROJECTION_COORDINATE",
        `duplicate projection coordinate ${coordinateKey}`,
      );
    }
    coordinateKeys.add(coordinateKey);

    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey).push(coordinate);
    annotated.push({ entry, inputIndex, ...coordinate });
  }

  for (const coordinates of lanes.values()) {
    coordinates.sort((left, right) => left.frameIndex - right.frameIndex);
    let priorRecordSeq = 0;
    for (const [index, coordinate] of coordinates.entries()) {
      const expected = index + 1;
      if (coordinate.frameIndex !== expected) {
        return reject(
          "NON_CONTIGUOUS_FRAME_INDEX",
          `projection lane expected frameIndex ${expected}, got ${coordinate.frameIndex}`,
        );
      }
      if (coordinate.recordSeq < priorRecordSeq) {
        return reject(
          "NON_MONOTONIC_FRAME_COORDINATE",
          "projection lane record sequence moves backwards",
        );
      }
      priorRecordSeq = coordinate.recordSeq;
    }
  }

  return annotated
    .sort((left, right) => left.recordSeq - right.recordSeq
      || left.frameIndex - right.frameIndex
      || left.inputIndex - right.inputIndex)
    .map(({ entry }) => entry);
}

export function isJsonRpcRequest(message) {
  return Boolean(message
    && typeof message === "object"
    && !Array.isArray(message)
    && typeof message.method === "string"
    && own(message, "id"));
}

export function isJsonRpcResponse(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (own(message, "method") || !own(message, "id")) return false;
  return own(message, "result") !== own(message, "error");
}

function defaultMessageOf(entry) {
  return entry?.message;
}

/**
 * Resolve a response to the nearest prior request on the requested direction,
 * using exact typed JSON-RPC id equality. A later request reusing the same id
 * shadows an earlier request even when its method is different.
 */
export function nearestPriorRpcRequest(entries, responseEntry, {
  rowOf = defaultRowOf,
  messageOf = defaultMessageOf,
  requestDirection,
} = {}) {
  if (typeof messageOf !== "function") {
    return reject("INVALID_MESSAGE_ACCESSOR", "messageOf must be a function");
  }
  requireNonEmptyString(requestDirection, "requestDirection");

  const ordered = orderProjectionEntries(entries, { rowOf });
  const responseIndex = ordered.indexOf(responseEntry);
  if (responseIndex < 0) {
    return reject("RESPONSE_NOT_IN_PROJECTION", "response entry is absent from projection entries");
  }

  // Validate every JSON-RPC id-bearing message before correlating. This keeps
  // an unsupported id from being silently skipped as an unrelated frame.
  for (const entry of ordered) {
    const message = messageOf(entry);
    if (message && typeof message === "object" && !Array.isArray(message) && own(message, "id")) {
      jsonRpcIdKey(message.id);
    }
  }

  const response = messageOf(responseEntry);
  if (!isJsonRpcResponse(response)) {
    return reject("NOT_JSON_RPC_RESPONSE", "response entry is not an exact JSON-RPC response");
  }
  const responseRow = rowOf(responseEntry);
  const responseId = jsonRpcIdKey(response.id);

  for (let index = responseIndex - 1; index >= 0; index -= 1) {
    const candidate = ordered[index];
    const row = rowOf(candidate);
    if (row.connection !== responseRow.connection || row.direction !== requestDirection) continue;
    const message = messageOf(candidate);
    if (!isJsonRpcRequest(message)) continue;
    if (jsonRpcIdKey(message.id) === responseId) return candidate;
  }
  return null;
}
