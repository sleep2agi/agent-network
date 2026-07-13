import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: project.mjs SAFE_BYTES_NDJSON PROJECTION_NDJSON");
const NATIVE_SAFETY_MAX_FRAME_BYTES = 1024 * 1024;

// This program intentionally imports nothing from the recorder or sanitizer.
// It independently reconstructs byte streams and parses newline-delimited JSON.
const records = readFileSync(input, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const groups = new Map();
for (const record of records) {
  const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

// Evidence metadata must come from the saved sanitized byte fixture itself.
// A prior live capture's maximum is not a protocol constant and must never be
// copied into projections for a different capture.
let nativeObservedSampleMaxFrameBytes = 0;
for (const streamRecords of groups.values()) {
  if (streamRecords[0]?.transport !== "leader-native-ipc") continue;
  const ordered = [...streamRecords].sort((a, b) => a.seq - b.seq);
  const bytes = Buffer.concat(ordered.map((record) => Buffer.from(record.bytesBase64, "base64")));
  let cursor = 0;
  while (bytes.length - cursor >= 4) {
    const advertisedLength = bytes.readUInt32BE(cursor);
    if (advertisedLength > NATIVE_SAFETY_MAX_FRAME_BYTES
      || bytes.length - cursor - 4 < advertisedLength) break;
    const payload = bytes.subarray(cursor + 4, cursor + 4 + advertisedLength);
    try {
      JSON.parse(payload.toString("utf8"));
      nativeObservedSampleMaxFrameBytes = Math.max(
        nativeObservedSampleMaxFrameBytes,
        advertisedLength,
      );
    } catch {
      // Invalid JSON is retained as a projection shape but does not establish
      // an observed valid-frame maximum.
    }
    cursor += 4 + advertisedLength;
  }
}

const projections = [];
for (const streamRecords of groups.values()) {
  streamRecords.sort((a, b) => a.seq - b.seq);
  const chunks = streamRecords.map((record) => ({
    seq: record.seq,
    bytes: Buffer.from(record.bytesBase64, "base64"),
  }));
  const bytes = Buffer.concat(chunks.map(({ bytes: chunk }) => chunk));
  const first = streamRecords[0];
  const recordSeqsFor = (start, end) => {
    const seqs = [];
    let chunkStart = 0;
    for (const chunk of chunks) {
      const chunkEnd = chunkStart + chunk.bytes.length;
      if (start < chunkEnd && end > chunkStart) seqs.push(chunk.seq);
      chunkStart = chunkEnd;
    }
    return seqs;
  };
  if (first.transport === "leader-native-ipc") {
    let cursor = 0;
    let frameIndex = 0;
    let terminalError = false;
    const eofRecords = streamRecords
      .filter((record) => record.boundary === "eof")
      .map((record) => record.seq);
    while (cursor < bytes.length) {
      const frameStart = cursor;
      if (bytes.length - cursor < 4) {
        const tail = bytes.subarray(cursor);
        projections.push({
          schema: "grok-wire-projection/v1",
          capture: first.capture,
          connection: first.connection,
          stream: first.stream,
          direction: first.direction,
          transport: first.transport,
          frameIndex: ++frameIndex,
          framing: "uint32-be-length+utf8-json",
          recordSeqs: recordSeqsFor(cursor, bytes.length),
          safetyMaximumFrameBytes: NATIVE_SAFETY_MAX_FRAME_BYTES,
          observedSampleMaxFrameBytes: nativeObservedSampleMaxFrameBytes,
          availableTailBytes: tail.length,
          terminatedByEof: eofRecords.length > 0,
          eofRecordSeqs: eofRecords,
          sanitizedBytesSha256: createHash("sha256").update(tail).digest("hex"),
          parseStatus: "truncated_native_header",
        });
        terminalError = true;
        cursor = bytes.length;
        break;
      }
      const advertisedLength = bytes.readUInt32BE(cursor);
      cursor += 4;
      if (advertisedLength > NATIVE_SAFETY_MAX_FRAME_BYTES) {
        projections.push({
          schema: "grok-wire-projection/v1",
          capture: first.capture,
          connection: first.connection,
          stream: first.stream,
          direction: first.direction,
          transport: first.transport,
          frameIndex: ++frameIndex,
          framing: "uint32-be-length+utf8-json",
          recordSeqs: recordSeqsFor(frameStart, cursor),
          safetyMaximumFrameBytes: NATIVE_SAFETY_MAX_FRAME_BYTES,
          observedSampleMaxFrameBytes: nativeObservedSampleMaxFrameBytes,
          advertisedLength,
          terminatedByEof: eofRecords.length > 0,
          eofRecordSeqs: eofRecords,
          parseStatus: "native_frame_too_large",
        });
        terminalError = true;
        break;
      }
      if (bytes.length - cursor < advertisedLength) {
        const tail = bytes.subarray(cursor);
        projections.push({
          schema: "grok-wire-projection/v1",
          capture: first.capture,
          connection: first.connection,
          stream: first.stream,
          direction: first.direction,
          transport: first.transport,
          frameIndex: ++frameIndex,
          framing: "uint32-be-length+utf8-json",
          recordSeqs: recordSeqsFor(frameStart, bytes.length),
          safetyMaximumFrameBytes: NATIVE_SAFETY_MAX_FRAME_BYTES,
          observedSampleMaxFrameBytes: nativeObservedSampleMaxFrameBytes,
          advertisedLength,
          availablePayloadBytes: tail.length,
          terminatedByEof: eofRecords.length > 0,
          eofRecordSeqs: eofRecords,
          sanitizedBytesSha256: createHash("sha256").update(tail).digest("hex"),
          parseStatus: "truncated_native_payload",
        });
        terminalError = true;
        cursor = bytes.length;
        break;
      }
      const outerBytes = bytes.subarray(cursor, cursor + advertisedLength);
      cursor += advertisedLength;
      let outer;
      let inner;
      let parseStatus = "complete_native_json";
      try {
        outer = JSON.parse(outerBytes.toString("utf8"));
      } catch {
        parseStatus = "invalid_native_json";
      }
      if (outer?.type === "acp") {
        if (typeof outer.payload === "string") {
          try {
            inner = JSON.parse(outer.payload);
          } catch {
            parseStatus = "invalid_inner_acp_payload";
          }
        } else if (outer.payload && typeof outer.payload === "object") {
          inner = outer.payload;
        } else {
          parseStatus = "invalid_inner_acp_payload";
        }
      }
      projections.push({
        schema: "grok-wire-projection/v1",
        capture: first.capture,
        connection: first.connection,
        stream: first.stream,
        direction: first.direction,
        transport: first.transport,
        frameIndex: ++frameIndex,
        framing: "uint32-be-length+utf8-json",
        recordSeqs: recordSeqsFor(frameStart, cursor),
        safetyMaximumFrameBytes: NATIVE_SAFETY_MAX_FRAME_BYTES,
        observedSampleMaxFrameBytes: nativeObservedSampleMaxFrameBytes,
        advertisedLength,
        sanitizedByteLength: outerBytes.length,
        sanitizedBytesSha256: createHash("sha256").update(outerBytes).digest("hex"),
        parseStatus,
        ...(outer === undefined ? {} : { outer }),
        ...(inner === undefined ? {} : { inner }),
      });
    }
    if (!terminalError && cursor === bytes.length && eofRecords.length > 0) {
      projections.push({
        schema: "grok-wire-projection/v1",
        capture: first.capture,
        connection: first.connection,
        stream: first.stream,
        direction: first.direction,
        transport: first.transport,
        frameIndex: ++frameIndex,
        framing: "transport_eof",
        recordSeqs: eofRecords,
        safetyMaximumFrameBytes: NATIVE_SAFETY_MAX_FRAME_BYTES,
        observedSampleMaxFrameBytes: nativeObservedSampleMaxFrameBytes,
        parseStatus: "clean_eof",
      });
    }
    continue;
  }
  if (first.transport === "test-policy-ipc") {
    let cursor = 0;
    let frameIndex = 0;
    let terminalError = false;
    const eofRecords = streamRecords
      .filter((record) => record.boundary === "eof")
      .map((record) => record.seq);
    while (cursor < bytes.length) {
      const frameStart = cursor;
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0) {
        const payloadBytes = bytes.subarray(cursor);
        let payload;
        try {
          payload = JSON.parse(payloadBytes.toString("utf8"));
        } catch {
          // A truncated policy record need not be valid JSON.
        }
        projections.push({
          schema: "grok-wire-projection/v1",
          capture: first.capture,
          connection: first.connection,
          stream: first.stream,
          direction: first.direction,
          transport: first.transport,
          frameIndex: ++frameIndex,
          framing: "eof_without_newline",
          recordSeqs: recordSeqsFor(frameStart, bytes.length),
          sanitizedByteLength: payloadBytes.length,
          sanitizedBytesSha256: createHash("sha256").update(payloadBytes).digest("hex"),
          parseStatus: "truncated_policy_json",
          ...(payload === undefined ? {} : { payload }),
        });
        terminalError = true;
        cursor = bytes.length;
        break;
      }
      const frameEnd = newline + 1;
      const payloadBytes = bytes.subarray(cursor, newline);
      let payload;
      let parseStatus;
      try {
        payload = JSON.parse(payloadBytes.toString("utf8"));
        parseStatus = "complete_policy_json";
      } catch {
        parseStatus = "invalid_policy_json";
        terminalError = true;
      }
      projections.push({
        schema: "grok-wire-projection/v1",
        capture: first.capture,
        connection: first.connection,
        stream: first.stream,
        direction: first.direction,
        transport: first.transport,
        frameIndex: ++frameIndex,
        framing: "newline",
        recordSeqs: recordSeqsFor(frameStart, frameEnd),
        sanitizedByteLength: payloadBytes.length,
        sanitizedBytesSha256: createHash("sha256").update(payloadBytes).digest("hex"),
        parseStatus,
        ...(payload === undefined ? {} : { payload }),
      });
      cursor = frameEnd;
    }
    if (!terminalError && cursor === bytes.length && eofRecords.length > 0) {
      projections.push({
        schema: "grok-wire-projection/v1",
        capture: first.capture,
        connection: first.connection,
        stream: first.stream,
        direction: first.direction,
        transport: first.transport,
        frameIndex: ++frameIndex,
        framing: "transport_eof",
        recordSeqs: eofRecords,
        parseStatus: "clean_eof",
      });
    }
    continue;
  }
  if (first.transport !== "acp-stdio") {
    projections.push({
      schema: "grok-wire-projection/v1",
      capture: first.capture,
      connection: first.connection,
      stream: first.stream,
      direction: first.direction,
      transport: first.transport,
      frameIndex: 1,
      framing: "opaque_transport_record",
      recordSeqs: chunks.map(({ seq }) => seq),
      sanitizedByteLength: bytes.length,
      sanitizedBytesSha256: createHash("sha256").update(bytes).digest("hex"),
      parseStatus: "opaque",
    });
    continue;
  }
  let frameStart = 0;
  let frameIndex = 0;
  for (let cursor = 0; cursor <= bytes.length; cursor += 1) {
    const atEnd = cursor === bytes.length;
    const atNewline = !atEnd && bytes[cursor] === 0x0a;
    if (!atEnd && !atNewline) continue;
    if (atEnd && frameStart === bytes.length) break;
    const frameEnd = atNewline ? cursor + 1 : cursor;
    const payloadEnd = cursor;
    const payloadBytes = bytes.subarray(frameStart, payloadEnd);
    const recordSeqs = [];
    let chunkStart = 0;
    for (const chunk of chunks) {
      const chunkEnd = chunkStart + chunk.bytes.length;
      if (frameStart < chunkEnd && frameEnd > chunkStart) recordSeqs.push(chunk.seq);
      chunkStart = chunkEnd;
    }
    let payload;
    let parseStatus;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
      parseStatus = "complete_json";
    } catch {
      parseStatus = atNewline ? "invalid_json" : "truncated_json";
    }
    projections.push({
      schema: "grok-wire-projection/v1",
      capture: first.capture,
      connection: first.connection,
      stream: first.stream,
      direction: first.direction,
      transport: first.transport,
      frameIndex: ++frameIndex,
      framing: atNewline ? "newline" : "eof_without_newline",
      recordSeqs,
      sanitizedByteLength: payloadBytes.length,
      sanitizedBytesSha256: createHash("sha256").update(payloadBytes).digest("hex"),
      parseStatus,
      ...(payload === undefined ? {} : { payload }),
    });
    frameStart = frameEnd;
  }
}

projections.sort((a, b) =>
  a.connection.localeCompare(b.connection)
  || a.stream.localeCompare(b.stream)
  || a.frameIndex - b.frameIndex);
writeFileSync(output, `${projections.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
  mode: 0o600,
});
