import { createReadStream, existsSync, lstatSync, statfsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, relative, resolve } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const [rawInputArg, summaryArg, sampleOutputArg, trialsOutputArg] = process.argv.slice(2);
if (!rawInputArg || !summaryArg || !sampleOutputArg || !trialsOutputArg) {
  throw new Error("usage: extract-exact-transport-sample.mjs RAW SUMMARY SAMPLE_RAW TRIALS_SUMMARY");
}

const rawInput = resolve(rawInputArg);
const summaryPath = resolve(summaryArg);
const sampleOutput = resolve(sampleOutputArg);
const trialsOutput = resolve(trialsOutputArg);
const rawDir = resolve(process.env.RAW_DIR || "");
if (!rawDir || !existsSync(rawDir) || Number(statfsSync(rawDir).type) !== TMPFS_MAGIC) {
  throw new Error("RAW_DIR must be an explicit tmpfs");
}
for (const path of [rawInput, sampleOutput]) {
  const rel = relative(rawDir, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("raw path escapes RAW_DIR");
  }
}
if (lstatSync(dirname(sampleOutput)).isSymbolicLink()) throw new Error("sample parent is symlink");

const summary = JSON.parse(await readFile(summaryPath, "utf8"));
const exact = summary.exactOneByteBufferedGateway;
if (summary.ok !== true
  || summary.protocolFreeze !== false
  || exact?.requestedTrials !== 100
  || exact?.completedTrials !== 100
  || exact?.passedTrials !== 100
  || exact?.failedTrials !== 0
  || exact?.requestedSegmentsPerTrial !== exact?.requestedBytesPerTrial
  || exact?.interSegmentDelayMs !== 1
  || exact?.minimumGatewayReadBytes !== 1
  || !(exact?.oneByteGatewayReadCallbacks > 0)) {
  throw new Error("exact transport summary is not a 100/100 owner candidate");
}

const sampleTrial = 100;
const clientConnection = `bounded-client-${sampleTrial}`;
const gatewayConnection = `bounded-gateway-${sampleTrial + 1}`;
const input = createInterface({
  input: createReadStream(rawInput, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
await writeFile(sampleOutput, "", { mode: 0o600, flag: "wx" });
let sequence = 0;
let firstMonoNs;
const counts = {
  clientWrites: 0,
  gatewayReads: 0,
  leaderFacingWrites: 0,
  leaderReads: 0,
  clientFacingWrites: 0,
  clientReads: 0,
};
const rawHash = createHash("sha256");
let rawRecordCount = 0;
const trialEvidence = new Map();
const getTrial = (trial) => {
  if (!trialEvidence.has(trial)) {
    trialEvidence.set(trial, {
      trial,
      clientWrites: [],
      clientReads: [],
      gatewayReads: [],
      leaderFacingWrites: [],
      leaderReads: [],
      clientFacingWrites: [],
    });
  }
  return trialEvidence.get(trial);
};

function exactTrialFor(record) {
  const client = /^bounded-client-(\d+)$/.exec(record.connection || "");
  if (client) {
    const trial = Number(client[1]);
    return trial >= 100 && trial < 200 ? trial : undefined;
  }
  const gateway = /^bounded-gateway-(\d+)$/.exec(record.connection || "");
  if (gateway) {
    const trial = Number(gateway[1]) - 1;
    return trial >= 100 && trial < 200 ? trial : undefined;
  }
  return undefined;
}

function decodeNative(stream) {
  const frames = [];
  let offset = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length) throw new Error("exact ledger has a truncated native header");
    const length = stream.readUInt32BE(offset);
    if (length > 1024 * 1024 || offset + 4 + length > stream.length) {
      throw new Error("exact ledger has a truncated/oversized native payload");
    }
    const outer = JSON.parse(stream.subarray(offset + 4, offset + 4 + length).toString("utf8"));
    let inner;
    if (outer?.type === "acp") {
      inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
    }
    frames.push({ outer, inner });
    offset += 4 + length;
  }
  return frames;
}

for await (const line of input) {
  if (!line) continue;
  rawHash.update(`${line}\n`);
  rawRecordCount += 1;
  const record = JSON.parse(line);
  const evidenceTrial = exactTrialFor(record);
  if (evidenceTrial !== undefined) {
    const evidence = getTrial(evidenceTrial);
    const bytes = Buffer.from(record.bytesBase64, "base64");
    if (record.connection === `bounded-client-${evidenceTrial}`) {
      if (record.direction === "client_to_gateway" && record.boundary === "write") {
        evidence.clientWrites.push(bytes);
      } else if (record.direction === "gateway_to_client" && record.boundary === "read") {
        evidence.clientReads.push(bytes);
      }
    } else if (record.direction === "client_to_gateway" && record.boundary === "read") {
      evidence.gatewayReads.push(bytes);
    } else if (record.direction === "gateway_to_leader" && record.boundary === "write") {
      evidence.leaderFacingWrites.push(bytes);
    } else if (record.direction === "leader_to_gateway" && record.boundary === "read") {
      evidence.leaderReads.push(bytes);
    } else if (record.direction === "gateway_to_client" && record.boundary === "write") {
      evidence.clientFacingWrites.push(bytes);
    }
  }
  const selectedClient = record.connection === clientConnection
    && record.phase === "exact-one-byte-1ms-buffered-gateway"
    && record.trial === sampleTrial;
  const selectedGateway = record.connection === gatewayConnection;
  if (!selectedClient && !selectedGateway) continue;

  let connection;
  if (selectedClient) connection = "transport-exact-client-1";
  else connection = "transport-exact-gateway-1";
  if (firstMonoNs === undefined) firstMonoNs = BigInt(record.monoNs);
  const normalized = {
    schema: record.schema,
    capture: "live-bounded-frame-transport",
    seq: ++sequence,
    monoNs: String(BigInt(record.monoNs) - firstMonoNs),
    role: record.role,
    transport: record.transport,
    connection,
    stream: record.stream,
    direction: record.direction,
    boundary: record.boundary,
    generation: record.generation,
    encoding: record.encoding,
    originalByteLength: record.originalByteLength,
    bytesBase64: record.bytesBase64,
  };
  await appendFile(sampleOutput, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });

  if (selectedClient && record.boundary === "write") counts.clientWrites += 1;
  else if (selectedGateway && record.direction === "client_to_gateway") counts.gatewayReads += 1;
  else if (selectedGateway && record.direction === "gateway_to_leader") counts.leaderFacingWrites += 1;
  else if (selectedGateway && record.direction === "leader_to_gateway") counts.leaderReads += 1;
  else if (selectedGateway && record.direction === "gateway_to_client") counts.clientFacingWrites += 1;
  else if (selectedClient && record.boundary === "read") counts.clientReads += 1;
}

const trialRows = [];
for (let trial = 100; trial < 200; trial += 1) {
  const evidence = trialEvidence.get(trial);
  if (!evidence) throw new Error(`exact trial ledger is missing trial ${trial}`);
  const request = Buffer.concat(evidence.clientWrites);
  const gatewayIngress = Buffer.concat(evidence.gatewayReads);
  const leaderFacing = Buffer.concat(evidence.leaderFacingWrites);
  const leaderResponse = Buffer.concat(evidence.leaderReads);
  const clientFacing = Buffer.concat(evidence.clientFacingWrites);
  const clientResponse = Buffer.concat(evidence.clientReads);
  const requestFrames = decodeNative(request);
  const leaderFacingFrames = decodeNative(leaderFacing);
  const responseFrames = decodeNative(clientFacing);
  const registered = responseFrames.some((frame) => frame.outer?.type === "registered");
  const initializeResponse = responseFrames.some((frame) => frame.inner?.id === 1
    && (frame.inner?.result !== undefined || frame.inner?.error !== undefined));
  const requestShapeOk = requestFrames.length === 2
    && requestFrames[0].outer?.type === "register"
    && requestFrames[1].outer?.type === "acp"
    && requestFrames[1].inner?.method === "initialize";
  const forwardedShapeOk = leaderFacingFrames.length === 2
    && leaderFacingFrames[0].outer?.type === "register"
    && leaderFacingFrames[1].inner?.method === "initialize";
  const oneByteWrites = evidence.clientWrites.every((bytes) => bytes.length === 1);
  const forwardedByteExact = request.equals(gatewayIngress) && request.equals(leaderFacing);
  const responseByteExact = clientFacing.equals(clientResponse);
  const passed = oneByteWrites
    && evidence.clientWrites.length === request.length
    && evidence.leaderFacingWrites.length === 2
    && requestShapeOk
    && forwardedShapeOk
    && forwardedByteExact
    && responseByteExact
    && registered
    && initializeResponse;
  if (!passed) throw new Error(`exact trial ledger failed trial ${trial}`);
  trialRows.push({
    trial,
    passed,
    requestBytes: request.length,
    clientWriteCallbacks: evidence.clientWrites.length,
    allClientWritesOneByte: oneByteWrites,
    gatewayReadCallbacks: evidence.gatewayReads.length,
    minimumGatewayReadBytes: Math.min(...evidence.gatewayReads.map((bytes) => bytes.length)),
    maximumGatewayReadBytes: Math.max(...evidence.gatewayReads.map((bytes) => bytes.length)),
    leaderFacingWriteCallbacks: evidence.leaderFacingWrites.length,
    leaderFacingFrameCount: leaderFacingFrames.length,
    clientFacingWriteCallbacks: evidence.clientFacingWrites.length,
    clientReadCallbacks: evidence.clientReads.length,
    requestSha256: createHash("sha256").update(request).digest("hex"),
    leaderFacingSha256: createHash("sha256").update(leaderFacing).digest("hex"),
    requestShapeSha256: createHash("sha256").update(JSON.stringify(
      requestFrames.map((frame) => ({ type: frame.outer?.type, method: frame.inner?.method || null })),
    )).digest("hex"),
    forwardedByteExact,
    responseByteExact,
    registered,
    initializeResponse,
    leaderResponseReadBytes: leaderResponse.length,
  });
}

const ledger = {
  schema: "test223-exact-transport-trial-ledger/v1",
  ok: true,
  protocolFreeze: false,
  sourceRawRecordCount: rawRecordCount,
  sourceRawSha256: rawHash.digest("hex"),
  requestedTrials: 100,
  passedTrials: trialRows.filter((row) => row.passed).length,
  aggregate: {
    clientWriteCallbacks: trialRows.reduce((sum, row) => sum + row.clientWriteCallbacks, 0),
    leaderFacingWriteCallbacks: trialRows.reduce(
      (sum, row) => sum + row.leaderFacingWriteCallbacks,
      0,
    ),
  },
  trials: trialRows,
};
await writeFile(trialsOutput, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });

if (sequence === 0
  || counts.clientWrites !== exact.requestedSegmentsPerTrial
  || counts.gatewayReads < 1
  || counts.leaderFacingWrites !== exact.expectedLeaderFacingFramesPerTrial
  || counts.leaderReads < 1
  || counts.clientFacingWrites < 1
  || counts.clientReads < 1) {
  throw new Error(`exact sample boundary counts mismatch: ${JSON.stringify({ sequence, counts })}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolFreeze: false,
  sampleTrial,
  records: sequence,
  counts,
})}\n`);
