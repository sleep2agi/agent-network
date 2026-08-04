import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import {
  MAX_INVENTORY_EVIDENCE_BYTES,
  MAX_INVENTORY_ROWS,
  MAX_INVENTORY_TOOL_NAME_BYTES,
  MAX_INVENTORY_TOOLS,
  MAX_TUI_READINESS_BYTES,
  bindInventorySocketBudget,
  childExitProven,
  currentMainRows,
  hasGrokTuiReadyMarker,
  invalidRequestObserved,
  makeBoundedRowRecorder,
  matchedMutationRows,
  noMainRequestCategory,
  normalizeInventoryTools,
  passesFixedInventory,
  safeInventoryMessageBytes,
  stableOwnedTuple,
  stableWrapperTuple,
} from "./inventory-gate.mjs";

const row = (overrides = {}) => ({
  run: "run",
  names: ["todo_write"],
  marker: true,
  promptNonce: true,
  skillsReminder: false,
  responseFinished: true,
  invalidRequest: false,
  ...overrides,
});

test("recognizes only the visible pinned TUI composer footer", () => {
  assert.equal(MAX_TUI_READINESS_BYTES, 128 * 1024);
  assert.equal(hasGrokTuiReadyMarker("leader socket ready"), false);
  assert.equal(
    hasGrokTuiReadyMarker("Shift+\x1b[31mTab\x1b[0m:mo\x1b[2Kde"),
    false,
  );
  assert.equal(hasGrokTuiReadyMarker("Shift+Tab:mode"), false);
  assert.equal(hasGrokTuiReadyMarker("Ctrl+x:shortcuts"), false);
  assert.equal(hasGrokTuiReadyMarker(
    "Shift+\x1b[31mTab\x1b[0m:mode  |  Ctrl+x:\x1b[2Kshortcuts",
  ), true);
  assert.equal(hasGrokTuiReadyMarker(
    "\x1b]0;Shift+Tab:mode  Ctrl+x:shortcuts\x07splash",
  ), false);
  assert.equal(hasGrokTuiReadyMarker(
    "\x1b]0;Shift+Tab:mode  Ctrl+x:shortcuts\x1b\\splash",
  ), false);
  assert.equal(hasGrokTuiReadyMarker(
    "\x1bPShift+Tab:mode  Ctrl+x:shortcuts",
  ), false);
  assert.equal(hasGrokTuiReadyMarker(
    "\x1bPShift+Tab:mode  Ctrl+x:shortcuts\x1b\\splash",
  ), false);
});

test("binds readiness to the current marker and nonce", () => {
  const rows = [
    row({ promptNonce: false }),
    row({ marker: false, names: ["session_title"] }),
  ];
  assert.deepEqual(currentMainRows(rows), []);
  rows.push(row());
  assert.deepEqual(currentMainRows(rows), [rows[2]]);
});

test("waits for a later matching mutation request", () => {
  const rows = [row(), row({ names: ["read_file", "todo_write"] })];
  assert.deepEqual(
    matchedMutationRows(rows, (candidate) => candidate.names.includes("read_file")),
    [rows[1]],
  );
});

test("late invalid traffic turns every fixed inventory gate red", () => {
  const rows = [row()];
  assert.equal(passesFixedInventory(rows, ["todo_write"]), true);
  rows.push(row({
    names: ["__invalid_request__"],
    marker: false,
    promptNonce: false,
    invalidRequest: true,
  }));
  assert.equal(invalidRequestObserved(rows), true);
  assert.equal(passesFixedInventory(rows, ["todo_write"]), false);
  assert.deepEqual(matchedMutationRows(
    rows,
    (candidate) => candidate.names.some((name) => name !== "todo_write"),
  ), []);
});

test("caps request evidence and records one fixed overflow sentinel", () => {
  const rows = [];
  const record = makeBoundedRowRecorder(rows, "run");
  for (let index = 0; index < MAX_INVENTORY_ROWS + 100; index += 1) record(row());
  assert.equal(rows.length, MAX_INVENTORY_ROWS);
  assert.equal(rows.at(-1).invalidRequest, true);
  assert.deepEqual(rows.at(-1).names, ["__request_overflow__"]);
  assert.equal(passesFixedInventory(rows, ["todo_write"]), false);

  const byteRows = [];
  const recordBytes = makeBoundedRowRecorder(byteRows, "run");
  const large = "x".repeat(16_384);
  while (!invalidRequestObserved(byteRows)) {
    recordBytes(row({ names: [large] }));
  }
  assert.ok(byteRows.length < MAX_INVENTORY_ROWS);
  assert.ok(Buffer.byteLength(JSON.stringify(byteRows), "utf8") <= MAX_INVENTORY_EVIDENCE_BYTES);
  assert.equal(byteRows.at(-1).invalidRequest, true);
});

test("rejects oversized tool inventories and UTF-8 names before retention", () => {
  const allowed = Array.from({ length: MAX_INVENTORY_TOOLS }, (_, index) => ({
    function: { name: `tool_${index}` },
  }));
  assert.equal(normalizeInventoryTools(allowed)?.length, MAX_INVENTORY_TOOLS);
  assert.equal(normalizeInventoryTools([...allowed, { name: "extra" }]), null);
  assert.equal(normalizeInventoryTools([{ name: "" }]), null);
  assert.equal(normalizeInventoryTools([{ name: "界".repeat(MAX_INVENTORY_TOOL_NAME_BYTES) }]), null);
  assert.deepEqual(normalizeInventoryTools([{ name: "z" }, { function: { name: "a" } }]), ["a", "z"]);
});

test("requires an exit proof when wrapper identity observation is unavailable", () => {
  const active = { pid: 41, state: "S", starttime: "100" };
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "",
  }, { status: "present", tuple: active }), false);
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "",
  }, { status: "absent" }), true);
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "",
  }, { status: "unknown" }), false);
  assert.equal(childExitProven({
    pid: 41, exitCode: 0, signalCode: null, wrapperStarttime: "",
  }, { status: "unknown" }), true);
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "100",
  }, { status: "present", tuple: active }), false);
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "100",
  }, { status: "present", tuple: { ...active, starttime: "101" } }), true);
  assert.equal(childExitProven({
    pid: 41, exitCode: null, signalCode: null, wrapperStarttime: "100",
  }, { status: "present", tuple: { ...active, state: "Z" } }), true);
});

test("rejects wrapper PID, group, or session reuse across a group scan", () => {
  const tuple = { pid: 41, state: "S", starttime: "100", pgrp: 41, sid: 41 };
  const present = (overrides = {}) => ({ status: "present", tuple: { ...tuple, ...overrides } });
  assert.equal(stableWrapperTuple(present(), present(), tuple), true);
  assert.equal(stableWrapperTuple(present(), present({ starttime: "101" }), tuple), false);
  assert.equal(stableWrapperTuple(present(), present({ pgrp: 42 }), tuple), false);
  assert.equal(stableWrapperTuple(present(), present({ sid: 42 }), tuple), false);
  assert.equal(stableWrapperTuple(present(), { status: "unknown" }, tuple), false);
  assert.equal(stableWrapperTuple(present({ state: "Z" }), present({ state: "Z" }), tuple), false);
});

test("rejects PID reuse across an ownership inspection", () => {
  const tuple = { pid: 51, state: "S", starttime: "200", pgrp: 51, sid: 51 };
  const before = { status: "present", tuple };
  assert.equal(stableOwnedTuple(before, true, { status: "present", tuple: { ...tuple } }), true);
  assert.equal(stableOwnedTuple(before, false, { status: "present", tuple: { ...tuple } }), false);
  assert.equal(stableOwnedTuple(before, true, {
    status: "present", tuple: { ...tuple, starttime: "201" },
  }), false);
  assert.equal(stableOwnedTuple(before, true, { status: "unknown" }), false);
});

test("turns excessive JSON nesting into a closed invalid observation", () => {
  let nested = [];
  for (let index = 0; index < 20_000; index += 1) nested = [nested];
  assert.equal(safeInventoryMessageBytes(nested), null);
  assert.equal(safeInventoryMessageBytes([{ role: "user", content: "ok" }])?.includes("ok"), true);
});

test("bounds slow and malformed model-stub connections", async () => {
  let invalid = 0;
  const server = http.createServer((_request, response) => response.end("ok"));
  const sockets = bindInventorySocketBudget(server, () => { invalid += 1; }, {
    maxSockets: 2,
    idleTimeoutMs: 50,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const clients = [0, 1, 2].map(() => net.connect(port, "127.0.0.1"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(invalid >= 1);
  assert.ok(sockets.size <= 2);
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));

  let malformedInvalid = 0;
  const malformedServer = http.createServer();
  bindInventorySocketBudget(malformedServer, () => { malformedInvalid += 1; }, {
    maxSockets: 2,
    idleTimeoutMs: 500,
  });
  await new Promise((resolve, reject) => {
    malformedServer.once("error", reject);
    malformedServer.listen(0, "127.0.0.1", resolve);
  });
  const malformedPort = malformedServer.address().port;
  const malformed = net.connect(malformedPort, "127.0.0.1", () => {
    malformed.write("not-http\r\n\r\n");
  });
  await new Promise((resolve) => malformed.once("close", resolve));
  assert.equal(malformedInvalid, 1);
  await new Promise((resolve) => malformedServer.close(resolve));
});

test("separates leader readiness from a ready leader with no request", () => {
  assert.equal(noMainRequestCategory({ exited: false, leaderObserved: false }), "leader_readiness");
  assert.equal(noMainRequestCategory({ exited: false, leaderObserved: true }), "request_timeout");
  assert.equal(noMainRequestCategory({ exited: true, leaderObserved: true }), null);
});
