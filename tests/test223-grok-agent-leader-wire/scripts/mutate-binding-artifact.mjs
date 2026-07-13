import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
if (!mode) {
  throw new Error("usage: mutate-binding-artifact.mjs MODE ARGS...");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resignFixture(manifest, path) {
  const fixture = manifest.fixtureFiles?.find((entry) => entry.path === basename(path));
  if (!fixture) throw new Error(`manifest has no fixture entry for ${basename(path)}`);
  fixture.sha256 = sha256(path);
}

function mutateNativeFrames(bytesPath, mutation) {
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const groups = new Map();
  for (const [recordIndex, record] of records.entries()) {
    if (record.transport !== "leader-native-ipc") continue;
    const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, recordIndex });
  }

  let changed = false;
  for (const group of groups.values()) {
    group.sort((a, b) => a.record.seq - b.record.seq);
    const stream = Buffer.concat(group.map(({ record }) => Buffer.from(record.bytesBase64, "base64")));
    const output = [];
    let cursor = 0;
    let groupChanged = false;
    while (cursor < stream.length) {
      if (stream.length - cursor < 4) {
        output.push(stream.subarray(cursor));
        cursor = stream.length;
        break;
      }
      const length = stream.readUInt32BE(cursor);
      if (length > 1024 * 1024 || stream.length - cursor - 4 < length) {
        output.push(stream.subarray(cursor));
        cursor = stream.length;
        break;
      }
      const payload = stream.subarray(cursor + 4, cursor + 4 + length);
      cursor += 4 + length;
      let rewritten = payload;
      try {
        const outer = JSON.parse(payload.toString("utf8"));
        if (!changed && outer?.type === "acp") {
          const innerWasString = typeof outer.payload === "string";
          const inner = innerWasString ? JSON.parse(outer.payload) : outer.payload;
          if (inner && typeof inner === "object" && mutation(inner)) {
            outer.payload = innerWasString ? JSON.stringify(inner) : inner;
            rewritten = Buffer.from(JSON.stringify(outer));
            changed = true;
            groupChanged = true;
          }
        }
      } catch {
        // The negative control only mutates fully parseable native ACP frames.
      }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(rewritten.length);
      output.push(header, rewritten);
    }
    if (!groupChanged) continue;

    const rewrittenStream = Buffer.concat(output);
    const dataEntries = group.filter(({ record }) => record.sanitizedByteLength > 0);
    if (dataEntries.length === 0) throw new Error("native group has no data records");
    let offset = 0;
    for (const [index, { record }] of dataEntries.entries()) {
      const final = index === dataEntries.length - 1;
      const length = final ? rewrittenStream.length - offset : record.sanitizedByteLength;
      if (length < 0) throw new Error("native mutation cannot preserve record partition");
      const bytes = rewrittenStream.subarray(offset, offset + length);
      offset += length;
      record.bytesBase64 = bytes.toString("base64");
      record.sanitizedByteLength = bytes.length;
      record.sanitizedBytesSha256 = createHash("sha256").update(bytes).digest("hex");
    }
    for (const { record } of group.filter(({ record }) => record.sanitizedByteLength === 0)) {
      record.bytesBase64 = "";
      record.sanitizedByteLength = 0;
      record.sanitizedBytesSha256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    }
    if (offset !== rewrittenStream.length) throw new Error("native mutation repartition lost bytes");
    break;
  }
  if (!changed) throw new Error(`no eligible native ACP frame for ${mode}`);
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function mutatePermissionMethods(bytesPath) {
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const groups = new Map();
  for (const [recordIndex, record] of records.entries()) {
    if (!["leader-native-ipc", "acp-stdio"].includes(record.transport)) continue;
    const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, recordIndex });
  }
  let changed = 0;
  for (const group of groups.values()) {
    group.sort((left, right) => left.record.seq - right.record.seq);
    const source = Buffer.concat(group.map(({ record }) => Buffer.from(record.bytesBase64, "base64")));
    const output = [];
    if (group[0].record.transport === "leader-native-ipc") {
      let cursor = 0;
      while (cursor < source.length) {
        if (source.length - cursor < 4) {
          output.push(source.subarray(cursor));
          cursor = source.length;
          break;
        }
        const length = source.readUInt32BE(cursor);
        if (length > 1024 * 1024 || source.length - cursor - 4 < length) {
          output.push(source.subarray(cursor));
          cursor = source.length;
          break;
        }
        const payload = source.subarray(cursor + 4, cursor + 4 + length);
        cursor += 4 + length;
        let rewritten = payload;
        try {
          const outer = JSON.parse(payload.toString("utf8"));
          if (outer?.type === "acp") {
            const stringPayload = typeof outer.payload === "string";
            const inner = stringPayload ? JSON.parse(outer.payload) : outer.payload;
            if (inner?.method === "session/request_permission") {
              inner.method = "session/update";
              outer.payload = stringPayload ? JSON.stringify(inner) : inner;
              rewritten = Buffer.from(JSON.stringify(outer));
              changed += 1;
            }
          }
        } catch {
          // Leave opaque/truncated data unchanged; the target is a parsed permission frame.
        }
        const header = Buffer.alloc(4);
        header.writeUInt32BE(rewritten.length);
        output.push(header, rewritten);
      }
    } else {
      let start = 0;
      for (let cursor = 0; cursor <= source.length; cursor += 1) {
        const newline = cursor < source.length && source[cursor] === 0x0a;
        if (!newline && cursor !== source.length) continue;
        if (cursor === source.length && start === source.length) break;
        const payload = source.subarray(start, cursor);
        let rewritten = payload;
        try {
          const message = JSON.parse(payload.toString("utf8"));
          if (message?.method === "session/request_permission") {
            message.method = "session/update";
            rewritten = Buffer.from(JSON.stringify(message));
            changed += 1;
          }
        } catch {
          // Preserve non-JSON/truncated tail.
        }
        output.push(rewritten);
        if (newline) output.push(Buffer.from("\n"));
        start = cursor + 1;
      }
    }
    const rewrittenStream = Buffer.concat(output);
    if (rewrittenStream.equals(source)) continue;
    let sourceCumulative = 0;
    let outputOffset = 0;
    for (const [index, { record }] of group.entries()) {
      sourceCumulative += record.sanitizedByteLength;
      const outputEnd = index === group.length - 1
        ? rewrittenStream.length
        : Math.floor((sourceCumulative / Math.max(1, source.length)) * rewrittenStream.length);
      const bytes = rewrittenStream.subarray(outputOffset, outputEnd);
      outputOffset = outputEnd;
      record.bytesBase64 = bytes.toString("base64");
      record.sanitizedByteLength = bytes.length;
      record.sanitizedBytesSha256 = createHash("sha256").update(bytes).digest("hex");
    }
  }
  if (changed === 0) throw new Error("permission mutation found no request frames");
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

if (["native-binding", "field-name", "correlation-numeric", "correlation-label"].includes(mode)) {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) throw new Error(`${mode} requires BYTES MANIFEST`);
  mutateNativeFrames(bytesPath, (inner) => {
    if (mode === "native-binding") {
      if (typeof inner.method !== "string" || !inner.method.includes("prompt")) return false;
      inner.method = inner.method.replace("prompt", "prompu");
      return true;
    }
    if (mode === "field-name") {
      if (!inner.params || typeof inner.params !== "object" || Array.isArray(inner.params)) return false;
      inner.params.field_name = "<STRING_1>";
      return true;
    }
    if (mode === "correlation-numeric") {
      if (typeof inner.id !== "number") return false;
      inner.id = 918273;
      return true;
    }
    if (typeof inner.id !== "string" || !/^<JSONRPC_ID_\d+>$/.test(inner.id)) return false;
    inner.id = "<WRONG_LABEL_999>";
    return true;
  });
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "metadata-unknown") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) throw new Error("metadata-unknown requires BYTES MANIFEST");
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (records.length === 0) throw new Error("metadata mutation requires a byte record");
  records[0].metadata_unknown = "<META_1>";
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "resign-files") {
  const [manifestPath, ...paths] = args;
  if (!manifestPath || paths.length === 0) throw new Error("resign-files requires MANIFEST FILE...");
  const manifest = readJson(manifestPath);
  for (const path of paths) resignFixture(manifest, path);
  writeJson(manifestPath, manifest);
} else if (mode === "env-coherent") {
  const [summaryPath, manifestPath] = args;
  if (!summaryPath || !manifestPath) throw new Error("env-coherent requires SUMMARY MANIFEST");
  const summary = readJson(summaryPath);
  summary.childEnvKeyNames = [...new Set([...(summary.childEnvKeyNames || []), "DATABASE_URL"])].sort();
  writeJson(summaryPath, summary);
  const manifest = readJson(manifestPath);
  manifest.capturePolicy.envKeyNames = [...summary.childEnvKeyNames];
  resignFixture(manifest, summaryPath);
  writeJson(manifestPath, manifest);
} else if ([
  "frame-summary-raw-count",
  "frame-summary-writer-frame",
  "frame-summary-writer-segment",
  "frame-summary-writer-original-bytes",
].includes(mode)) {
  const [summaryPath, manifestPath] = args;
  if (!summaryPath || !manifestPath) throw new Error(`${mode} requires SUMMARY MANIFEST`);
  const summary = readJson(summaryPath);
  if (mode === "frame-summary-raw-count") summary.rawCapture.records += 1;
  const writer = summary.gatewayMetrics?.tuiWriters?.find((entry) => entry.label === "tui-to-leader");
  if (mode !== "frame-summary-raw-count" && !writer) throw new Error("frame summary has no tui-to-leader writer");
  if (mode === "frame-summary-writer-frame") writer.frames += 1;
  if (mode === "frame-summary-writer-segment") writer.writeSegments += 1;
  if (mode === "frame-summary-writer-original-bytes") {
    writer.requestedBytes += 1;
    writer.completedBytes += 1;
  }
  writeJson(summaryPath, summary);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, summaryPath);
  writeJson(manifestPath, manifest);
} else if (mode === "frame-bytes-connection") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) throw new Error("frame-bytes-connection requires BYTES MANIFEST");
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let changed = 0;
  for (const record of records) {
    // Move the entire correlation namespace, not a single stream. This keeps
    // the mutation coherent for the generic correlation ledger while making
    // the frame-aware verifier's exact provenance tuple disappear.
    if (record.connection === "tui-native-1") {
      record.connection = "native-1";
      changed += 1;
    }
  }
  if (changed === 0) throw new Error("frame tuple mutation found no records");
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "permission-method") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) throw new Error("permission-method requires BYTES MANIFEST");
  mutatePermissionMethods(bytesPath);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "approval-summary-tui-count") {
  const [summaryPath, manifestPath] = args;
  if (!summaryPath || !manifestPath) throw new Error("approval-summary-tui-count requires SUMMARY MANIFEST");
  const summary = readJson(summaryPath);
  summary.ownerDisconnect.realTuiResponseAttempts += 1;
  summary.ownerDisconnect.realTuiResponsesSuppressed += 1;
  writeJson(summaryPath, summary);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, summaryPath);
  writeJson(manifestPath, manifest);
} else {
  throw new Error(`unknown mutation mode: ${mode}`);
}
