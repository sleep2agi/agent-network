export const MAX_INVENTORY_ROWS = 256;
export const MAX_INVENTORY_EVIDENCE_BYTES = 1_048_576;
export const MAX_INVENTORY_TOOLS = 128;
export const MAX_INVENTORY_TOOL_NAME_BYTES = 256;

export function normalizeInventoryTools(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_INVENTORY_TOOLS) return null;
  const names = [];
  for (const tool of tools) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name !== "string"
      || name.length === 0
      || Buffer.byteLength(name, "utf8") > MAX_INVENTORY_TOOL_NAME_BYTES) {
      return null;
    }
    names.push(name);
  }
  return names.sort();
}

export function childExitProven({
  pid,
  exitCode,
  signalCode,
  wrapperStarttime,
}, currentObservation) {
  if (!pid
    || (exitCode !== null && exitCode !== undefined)
    || (signalCode !== null && signalCode !== undefined)) return true;
  if (currentObservation?.status === "absent") return true;
  if (currentObservation?.status !== "present") return false;
  const currentTuple = currentObservation.tuple;
  if (["Z", "X"].includes(currentTuple.state)) return true;
  if (!wrapperStarttime) return false;
  return currentTuple.starttime !== wrapperStarttime;
}

export function stableWrapperTuple(before, after, expected) {
  if (before?.status !== "present" || after?.status !== "present") return false;
  const first = before.tuple;
  const second = after.tuple;
  return first.starttime === expected.starttime
    && first.pgrp === expected.pgrp
    && first.sid === expected.sid
    && second.starttime === first.starttime
    && second.pgrp === first.pgrp
    && second.sid === first.sid
    && !["Z", "X"].includes(first.state)
    && !["Z", "X"].includes(second.state);
}

export function stableOwnedTuple(before, ownershipMatched, after) {
  return ownershipMatched === true
    && before?.status === "present"
    && stableWrapperTuple(before, after, before.tuple);
}

export function safeInventoryMessageBytes(messages) {
  try {
    return JSON.stringify(messages);
  } catch {
    return null;
  }
}

export function bindInventorySocketBudget(server, recordInvalid, {
  maxSockets = 16,
  idleTimeoutMs = 5_000,
} = {}) {
  const activeSockets = new Set();
  server.maxConnections = maxSockets;
  server.requestTimeout = idleTimeoutMs;
  server.headersTimeout = idleTimeoutMs;
  server.keepAliveTimeout = Math.min(1_000, idleTimeoutMs);
  server.on("connection", (socket) => {
    if (activeSockets.size >= maxSockets) {
      recordInvalid();
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    let timeoutRecorded = false;
    socket.setTimeout(idleTimeoutMs);
    socket.once("timeout", () => {
      if (!timeoutRecorded) {
        timeoutRecorded = true;
        recordInvalid();
      }
      socket.destroy();
    });
    socket.once("close", () => { activeSockets.delete(socket); });
  });
  server.on("drop", recordInvalid);
  server.on("clientError", (_error, socket) => {
    recordInvalid();
    socket.destroy();
  });
  return activeSockets;
}

function rowEvidenceBytes(row) {
  // One extra byte reserves the comma that separates this row in an array.
  return Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
}

export function makeBoundedRowRecorder(rows, run) {
  let evidenceBytes = 2 + rows.reduce((total, row) => total + rowEvidenceBytes(row), 0);
  let overflowed = rows.some((row) => row.names?.[0] === "__request_overflow__");
  return (row) => {
    if (overflowed) return;
    const rowBytes = rowEvidenceBytes(row);
    const overflowRow = {
      run,
      names: ["__request_overflow__"],
      marker: false,
      promptNonce: false,
      skillsReminder: false,
      responseFinished: true,
      invalidRequest: true,
    };
    const overflowBytes = rowEvidenceBytes(overflowRow);
    if (rows.length >= MAX_INVENTORY_ROWS - 1
      || evidenceBytes + rowBytes + overflowBytes > MAX_INVENTORY_EVIDENCE_BYTES) {
      overflowed = true;
      rows.push(overflowRow);
      return;
    }
    rows.push(row);
    evidenceBytes += rowBytes;
  };
}

export function invalidRequestObserved(rows) {
  return rows.some((row) => row.invalidRequest === true);
}

export function currentMainRows(rows) {
  return rows.filter((row) =>
    row.invalidRequest !== true && row.marker === true && row.promptNonce === true);
}

export function matchedMutationRows(rows, predicate) {
  return currentMainRows(rows).filter((row) => predicate(row));
}

export function noMainRequestCategory({ exited, leaderObserved }) {
  if (exited) return null;
  return leaderObserved ? "request_timeout" : "leader_readiness";
}

export function passesFixedInventory(rows, expectedTools) {
  const main = rows.filter((row) => row.marker);
  const auxiliaries = rows.filter((row) => !row.marker);
  return !invalidRequestObserved(rows)
    && main.length > 0
    && main.every((row) => row.promptNonce
      && JSON.stringify(row.names) === JSON.stringify(expectedTools))
    && auxiliaries.every((row) =>
      JSON.stringify(row.names) === JSON.stringify(["session_title"]));
}
