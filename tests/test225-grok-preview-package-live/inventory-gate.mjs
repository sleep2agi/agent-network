export const MAX_INVENTORY_ROWS = 256;
export const MAX_INVENTORY_EVIDENCE_BYTES = 1_048_576;
export const MAX_INVENTORY_TOOLS = 128;
export const MAX_INVENTORY_TOOL_NAME_BYTES = 256;
export const MAX_TUI_READINESS_BYTES = 128 * 1024;

const GROK_TUI_READY_TEXT = "Shift+Tab:mode";
const GROK_TUI_SHORTCUTS_TEXT = "Ctrl+x:shortcuts";

// Keep the keyless inventory client on the same pinned 0.2.93 readiness
// boundary as production. The Leader socket appears before the composer is
// accepting input, and terminal control strings must not be able to forge the
// two visible footer markers.
export function hasGrokTuiReadyMarker(raw) {
  let visible = "";
  let state = "text";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = raw[index];
    if (state === "text") {
      if (code === 0x1b) state = "escape";
      else if (code === 0x9b) state = "csi";
      else if (code === 0x9d) state = "osc";
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        state = "control-string";
      } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
        visible += char;
      }
      continue;
    }
    if (state === "escape") {
      if (char === "[") state = "csi";
      else if (char === "]") state = "osc";
      else if (char === "P" || char === "X" || char === "^" || char === "_") {
        state = "control-string";
      } else state = "text";
      continue;
    }
    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "text";
      continue;
    }
    if (state === "osc" && code === 0x07) {
      state = "text";
      continue;
    }
    if (code === 0x1b && raw[index + 1] === "\\") {
      index += 1;
      state = "text";
    }
  }
  return visible.includes(GROK_TUI_READY_TEXT)
    && visible.includes(GROK_TUI_SHORTCUTS_TEXT);
}

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
