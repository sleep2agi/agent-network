import assert from "node:assert/strict";

import {
  RpcOrderError,
  jsonRpcIdKey,
  nearestPriorRpcRequest,
  orderProjectionEntries,
  projectionCoordinate,
} from "../lib/rpc-order.mjs";

const requestDirection = "real_leader_to_tap";
const responseDirection = "tap_to_real_leader";

function entry({ seq, frameIndex, direction, message, connection = "tap-1" }) {
  return {
    row: {
      capture: "rpc-order-selftest",
      transport: "leader-native-ipc",
      connection,
      stream: "socket",
      direction,
      recordSeqs: [seq],
      frameIndex,
    },
    message,
  };
}

function correlate(entries, response) {
  return nearestPriorRpcRequest(entries, response, { requestDirection });
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof RpcOrderError && error.code === code);
}

assert.deepEqual(
  projectionCoordinate({ recordSeqs: [9, 4, 7], frameIndex: 2 }),
  { recordSeq: 4, frameIndex: 2 },
);

// A numeric id and its string spelling are separate JSON-RPC namespaces.
{
  const numeric = entry({
    seq: 1,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 7, method: "session/request_permission" },
  });
  const string = entry({
    seq: 2,
    frameIndex: 2,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: "7", method: "session/prompt" },
  });
  const numericResponse = entry({
    seq: 3,
    frameIndex: 1,
    direction: responseDirection,
    message: { jsonrpc: "2.0", id: 7, result: { outcome: "cancelled" } },
  });
  const stringResponse = entry({
    seq: 4,
    frameIndex: 2,
    direction: responseDirection,
    message: { jsonrpc: "2.0", id: "7", result: {} },
  });
  const rows = [stringResponse, numeric, numericResponse, string];
  assert.equal(correlate(rows, numericResponse), numeric);
  assert.equal(correlate(rows, stringResponse), string);
  assert.notEqual(jsonRpcIdKey(7), jsonRpcIdKey("7"));
}

// Coalesced requests can reuse an id. The later non-permission request shadows
// the earlier permission request for a subsequent response.
{
  const permission = entry({
    seq: 10,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 11, method: "session/request_permission" },
  });
  const laterNonPermission = entry({
    seq: 10,
    frameIndex: 2,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 11, method: "session/prompt" },
  });
  const response = entry({
    seq: 11,
    frameIndex: 1,
    direction: responseDirection,
    message: { jsonrpc: "2.0", id: 11, result: {} },
  });
  assert.equal(correlate([response, permission, laterNonPermission], response), laterNonPermission);
}

// For two frames in one record, frameIndex is a real ordering coordinate. A
// coherent swap changes which reused request is nearest instead of falling
// back to array order or timestamp order.
{
  const permission = entry({
    seq: 20,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 12, method: "session/request_permission" },
  });
  const nonPermission = entry({
    seq: 20,
    frameIndex: 2,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 12, method: "session/prompt" },
  });
  const response = entry({
    seq: 21,
    frameIndex: 1,
    direction: responseDirection,
    message: { jsonrpc: "2.0", id: 12, result: {} },
  });
  assert.equal(correlate([permission, nonPermission, response], response), nonPermission);
  permission.row.frameIndex = 2;
  nonPermission.row.frameIndex = 1;
  assert.equal(correlate([permission, nonPermission, response], response), permission);
}

// Duplicate and discontinuous frame coordinates fail closed.
{
  const duplicateA = entry({
    seq: 30,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 1, method: "initialize" },
  });
  const duplicateB = entry({
    seq: 30,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 2, method: "authenticate" },
  });
  expectCode("DUPLICATE_PROJECTION_COORDINATE", () =>
    orderProjectionEntries([duplicateA, duplicateB]));

  const gapA = entry({
    seq: 31,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 1, method: "initialize" },
  });
  const gapB = entry({
    seq: 32,
    frameIndex: 3,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: 2, method: "authenticate" },
  });
  expectCode("NON_CONTIGUOUS_FRAME_INDEX", () => orderProjectionEntries([gapA, gapB]));
}

// Values outside JSON-RPC's supported string/number id types are never
// coerced or ignored during correlation.
for (const unsupported of [null, true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
  expectCode("UNSUPPORTED_JSON_RPC_ID", () => jsonRpcIdKey(unsupported));
}
{
  const request = entry({
    seq: 40,
    frameIndex: 1,
    direction: requestDirection,
    message: { jsonrpc: "2.0", id: null, method: "session/request_permission" },
  });
  const response = entry({
    seq: 41,
    frameIndex: 1,
    direction: responseDirection,
    message: { jsonrpc: "2.0", id: 1, result: {} },
  });
  expectCode("UNSUPPORTED_JSON_RPC_ID", () => correlate([request, response], response));
}

console.log("rpc-order selftest: PASS");
