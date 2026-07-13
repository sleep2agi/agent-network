import { deepStrictEqual, match, notDeepStrictEqual, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  canonical,
  deriveCandidateScopes,
  sha256,
} from "./derive-candidate-live-exact-scopes.mjs";

const suiteRoot = fileURLToPath(new URL("../", import.meta.url));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const allowlistPath = join(suiteRoot, "protocol-allowlist.json");
const scriptPath = fileURLToPath(new URL("derive-candidate-live-exact-scopes.mjs", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "test223-candidate-scope-"));

function nativeRow({ recordSeq, frameIndex = 1, direction, rpc, connection = "scope-selftest-1" }) {
  return {
    schema: "grok-wire-projection/v1",
    capture: "leader-native-tui",
    connection,
    stream: "scope-selftest",
    direction,
    transport: "leader-native-ipc",
    frameIndex,
    recordSeqs: [recordSeq],
    parseStatus: "complete_native_json",
    outer: { type: "acp", payload: JSON.stringify(rpc) },
    inner: rpc,
  };
}

function acpRow({ recordSeq, payload }) {
  return {
    schema: "grok-wire-projection/v1",
    capture: "leader-native-tui",
    connection: "scope-selftest-stdio-1",
    stream: "stdout",
    direction: "grok_to_client",
    transport: "acp-stdio",
    frameIndex: 1,
    recordSeqs: [recordSeq],
    parseStatus: "complete_json",
    payload,
  };
}

const request = {
  jsonrpc: "2.0",
  id: 7,
  method: "_x.ai/prompt_history",
  params: { cwd: "<PATH_1>", filter_session_id: "<SESSION_ID_1>" },
};
const response = {
  jsonrpc: "2.0",
  id: 7,
  result: { prompts: ["<BODY_1>"] },
};
const notification = {
  jsonrpc: "2.0",
  method: "_x.ai/mcp/servers_updated",
  params: { mcpServers: [] },
};
const positiveRows = [
  nativeRow({ recordSeq: 1, direction: "client_to_gateway", rpc: request }),
  nativeRow({ recordSeq: 2, direction: "gateway_to_client", rpc: response }),
  acpRow({ recordSeq: 3, payload: notification }),
];

function saveRows(name, rows) {
  const path = join(temporary, `${name}.projection.ndjson`);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}

function expectClosed(label, rows, expected) {
  const path = saveRows(label, rows);
  let error;
  try {
    deriveCandidateScopes({
      allowlistPath,
      fixtures: [{ stem: "leader-native-tui", projectionPath: path }],
    });
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`${label}: expected fail-closed result`);
  match(error.message, expected, label);
}

try {
  const projectionPath = saveRows("positive", positiveRows);
  const direct = deriveCandidateScopes({
    allowlistPath,
    fixtures: [{ stem: "leader-native-tui", projectionPath }],
  });
  strictEqual(direct.schema, "test223-candidate-live-exact-scopes/v1");
  strictEqual(direct.status, "pending-independent-fixture-acceptance");
  strictEqual(direct.authorizesPersistence, false);
  strictEqual(direct.namespace.semver, "0.2.93");
  strictEqual(direct.namespace.binarySha256,
    "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135");
  strictEqual(direct.authorizesExactShapeAcceptance, false);
  strictEqual(direct.fixtures.length, 1);
  strictEqual(direct.fixtures[0].completeFrameCount, 3);
  strictEqual(direct.fixtures[0].allowedShapeSha256.length, 3);
  deepStrictEqual(direct.fixtures[0].allowedShapeSha256, [
    "a70d5a889b3d23a481dd71b116523864a9a4498eeaa88067a29e7b0caee8dbad",
    "a734a057a91c8db856ab8700a0b421f9bbc8e8966151c3a2f1161ed167bc28af",
    "fba1d4bb09fe201465dd308c3be8c48f9aed341f1d85d2de8d2822f766998027",
  ]);

  const outputPath = join(temporary, "candidate-scopes.json");
  const cli = spawnSync(process.execPath, [
    scriptPath,
    "--allowlist", allowlistPath,
    "--output", outputPath,
    "--fixture", `leader-native-tui=${projectionPath}`,
  ], { encoding: "utf8" });
  strictEqual(cli.status, 0, cli.stderr);
  deepStrictEqual(JSON.parse(readFileSync(outputPath, "utf8")), direct);
  match(cli.stdout, /"status":"pending-independent-fixture-acceptance"/);

  const staleScalarRows = structuredClone(positiveRows);
  staleScalarRows[2].payload.jsonrpc = "<STRING_1>";
  const selectorProjectionPath = saveRows("selector-seed", staleScalarRows);
  const selectorSeed = deriveCandidateScopes({
    allowlistPath,
    selectorSeedOnly: true,
    fixtures: [{
      stem: "leader-native-tui",
      projectionPath: selectorProjectionPath,
    }],
  });
  strictEqual(selectorSeed.schema, "test223-candidate-live-selector-seeds/v1");
  strictEqual(selectorSeed.source, "stale-projection-selector-only");
  strictEqual(selectorSeed.authorizesPersistence, false);
  strictEqual(selectorSeed.authorizesExactShapeAcceptance, false);
  strictEqual(selectorSeed.fixtures[0].allowedSelectorSha256.length, 3);
  strictEqual(own(selectorSeed.fixtures[0], "allowedShapeSha256"), false);

  const selectorOutputPath = join(temporary, "selector-seeds.json");
  const selectorCli = spawnSync(process.execPath, [
    scriptPath,
    "--selector-seed-only",
    "--allowlist", allowlistPath,
    "--output", selectorOutputPath,
    "--fixture", `leader-native-tui=${selectorProjectionPath}`,
  ], { encoding: "utf8" });
  strictEqual(selectorCli.status, 0, selectorCli.stderr);
  deepStrictEqual(JSON.parse(readFileSync(selectorOutputPath, "utf8")), selectorSeed);

  const selectorUnknownMethod = structuredClone(staleScalarRows);
  selectorUnknownMethod[0].inner.method = "PRIVATE_CUSTOMER_METHOD_ALICE";
  selectorUnknownMethod[0].outer.payload = JSON.stringify(selectorUnknownMethod[0].inner);
  let selectorMethodError;
  try {
    deriveCandidateScopes({
      allowlistPath,
      selectorSeedOnly: true,
      fixtures: [{
        stem: "leader-native-tui",
        projectionPath: saveRows("selector-unknown-method", selectorUnknownMethod),
      }],
    });
  } catch (caught) {
    selectorMethodError = caught;
  }
  match(selectorMethodError?.message ?? "", /<UNREVIEWED_METHOD>/);

  const opaqueChanged = structuredClone(positiveRows);
  opaqueChanged[0].inner.params.cwd = "<PATH_999>";
  opaqueChanged[0].outer.payload = JSON.stringify(opaqueChanged[0].inner);
  const opaqueResult = deriveCandidateScopes({
    allowlistPath,
    fixtures: [{
      stem: "leader-native-tui",
      projectionPath: saveRows("opaque-changed", opaqueChanged),
    }],
  });
  deepStrictEqual(opaqueResult.fixtures[0].allowedShapeSha256,
    direct.fixtures[0].allowedShapeSha256,
    "opaque values must not widen or alter an exact shape scope");

  const reverseNotification = structuredClone(positiveRows);
  reverseNotification[2].direction = "client_to_grok";
  const reverseResult = deriveCandidateScopes({
    allowlistPath,
    fixtures: [{
      stem: "leader-native-tui",
      projectionPath: saveRows("reverse-notification", reverseNotification),
    }],
  });
  strictEqual(reverseResult.fixtures[0].allowedShapeSha256.length, 3);
  notDeepStrictEqual(
    reverseResult.fixtures[0].allowedShapeSha256,
    direct.fixtures[0].allowedShapeSha256,
    "request/notification direction must be part of the candidate scope hash",
  );

  const unknownMethod = structuredClone(positiveRows);
  unknownMethod[0].inner.method = "PRIVATE_CUSTOMER_METHOD_ALICE";
  unknownMethod[0].outer.payload = JSON.stringify(unknownMethod[0].inner);
  expectClosed(
    "unknown-method",
    unknownMethod,
    /selector is outside candidate exact policy; diagnostics=.*<UNREVIEWED_METHOD>/,
  );

  const placeholderMethod = structuredClone(positiveRows);
  placeholderMethod[0].inner.method = "<METHOD_1>";
  placeholderMethod[0].outer.payload = JSON.stringify(placeholderMethod[0].inner);
  expectClosed("placeholder-method", placeholderMethod, /generic placeholder/);

  const placeholderScalar = structuredClone(positiveRows);
  placeholderScalar[2].payload.jsonrpc = "<STRING_1>";
  expectClosed("placeholder-exact-scalar", placeholderScalar, /exact scalar.*generic placeholder/);

  const unknownScalar = structuredClone(positiveRows);
  unknownScalar[2].payload.jsonrpc = "3.0";
  expectClosed(
    "unknown-exact-scalar",
    unknownScalar,
    /shape\/exact scalars are outside.*"exactScalarPaths":\["\$rpc\.jsonrpc"\].*"mismatchKind":"scalar"/,
  );

  const missingPath = structuredClone(positiveRows);
  delete missingPath[0].inner.params.filter_session_id;
  missingPath[0].outer.payload = JSON.stringify(missingPath[0].inner);
  expectClosed(
    "missing-reviewed-path",
    missingPath,
    /"mismatchKind":"path".*"missingReviewedPaths":\["\$rpc\.params\.filter_session_id"\]/,
  );

  const authenticate = {
    jsonrpc: "2.0",
    id: 9,
    method: "authenticate",
    params: {
      methodId: "sha256:857fd9ec1d2095f7fc12d500d75c66cd5b67d8343f91b289fce13f36291bd944",
    },
  };
  const persistedFingerprint = deriveCandidateScopes({
    allowlistPath,
    fixtures: [{
      stem: "leader-native-tui",
      projectionPath: saveRows("persisted-fingerprint", [nativeRow({
        recordSeq: 1,
        direction: "client_to_gateway",
        rpc: authenticate,
      })]),
    }],
  });
  strictEqual(persistedFingerprint.fixtures[0].allowedShapeSha256.length, 1);
  const unhashedExact = structuredClone(authenticate);
  unhashedExact.params.methodId = "not-a-persisted-fingerprint";
  expectClosed("unhashed-exact-string", [nativeRow({
    recordSeq: 1,
    direction: "client_to_gateway",
    rpc: unhashedExact,
  })], /lacks the persisted typed-string fingerprint at \$rpc\.params\.methodId/);

  const duplicateRequest = structuredClone(positiveRows);
  duplicateRequest.splice(1, 0, nativeRow({
    recordSeq: 2,
    frameIndex: 2,
    direction: "client_to_gateway",
    rpc: structuredClone(request),
  }));
  duplicateRequest[2].recordSeqs = [3];
  duplicateRequest[3].recordSeqs = [4];
  expectClosed("ambiguous-response", duplicateRequest, /correlation is ambiguous/);

  const typedMismatch = structuredClone(positiveRows);
  typedMismatch[1].inner.id = "7";
  typedMismatch[1].outer.payload = JSON.stringify(typedMismatch[1].inner);
  expectClosed("typed-id-mismatch", typedMismatch, /typed-id correlation/);

  const connectionMismatch = structuredClone(positiveRows);
  connectionMismatch[1].connection = "scope-selftest-2";
  expectClosed("connection-mismatch", connectionMismatch, /typed-id correlation/);

  const directionMismatch = structuredClone(positiveRows);
  directionMismatch[1].direction = "leader_to_gateway";
  expectClosed("direction-mismatch", directionMismatch, /typed-id correlation/);

  const responseFirst = structuredClone(positiveRows);
  responseFirst[0] = nativeRow({ recordSeq: 1, direction: "gateway_to_client", rpc: response });
  responseFirst[1] = nativeRow({ recordSeq: 2, direction: "client_to_gateway", rpc: request });
  expectClosed("response-before-request", responseFirst, /typed-id correlation/);

  const unknownStatus = structuredClone(positiveRows);
  unknownStatus[0].parseStatus = "complete_future_protocol";
  expectClosed("unknown-parse-status", unknownStatus, /unknown parse status/);

  const mismatchedPayload = structuredClone(positiveRows);
  mismatchedPayload[0].outer.payload = JSON.stringify({ ...request, id: 8 });
  expectClosed("outer-inner-mismatch", mismatchedPayload, /outer payload and inner projection differ/);

  const unbound = saveRows("unbound", positiveRows.map((row) => ({
    ...row,
    capture: "unreviewed-capture",
  })));
  let unboundError;
  try {
    deriveCandidateScopes({
      allowlistPath,
      fixtures: [{ stem: "leader-native-tui", projectionPath: unbound }],
    });
  } catch (caught) {
    unboundError = caught;
  }
  match(unboundError?.message ?? "", /not uniquely candidate-bound/);

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  allowlist.candidateLiveExactShapePolicy.selectors[0].selector.method = "<METHOD_1>";
  const badPolicyPath = join(temporary, "bad-policy.json");
  writeFileSync(badPolicyPath, `${JSON.stringify(allowlist)}\n`);
  let policyError;
  try {
    deriveCandidateScopes({
      allowlistPath: badPolicyPath,
      fixtures: [{ stem: "leader-native-tui", projectionPath }],
    });
  } catch (caught) {
    policyError = caught;
  }
  match(policyError?.message ?? "", /generic placeholder/);

  strictEqual(
    sha256(canonical({ selector: { a: 1 }, paths: [], enums: [] })),
    "9f8b1f0dba2e9f75d60925c171af6a60650016868ea9bcc066a684a032e9c2bb",
    "canonical shape hashing contract changed",
  );
  process.stdout.write("PASS candidate live exact scope derivation + fail-closed matrix\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
