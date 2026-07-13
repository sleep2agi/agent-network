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
        if (!changed && outer && typeof outer === "object" && !Array.isArray(outer)) {
          const innerWasString = outer.type === "acp" && typeof outer.payload === "string";
          const inner = outer.type === "acp"
            ? (innerWasString ? JSON.parse(outer.payload) : outer.payload)
            : undefined;
          if (mutation(inner, outer)) {
            if (outer.type === "acp") {
              outer.payload = innerWasString ? JSON.stringify(inner) : inner;
            }
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

if ([
  "native-binding",
  "method-unknown",
  "field-name",
  "field-cross-context",
  "enum-unknown",
  "enum-cross-context",
  "enum-wrong-type",
  "client-type-wrong-label",
  "correlation-numeric",
  "correlation-label",
  "capture-cross-context-method",
  "method-generic-placeholder",
].includes(mode)) {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) throw new Error(`${mode} requires BYTES MANIFEST`);
  mutateNativeFrames(bytesPath, (inner, outer) => {
    if (mode === "client-type-wrong-label") {
      if (outer?.type !== "register" || typeof outer.client_type !== "string") return false;
      outer.client_type = "<STRING_999>";
      return true;
    }
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return false;
    if ([
      "native-binding",
      "method-unknown",
      "capture-cross-context-method",
      "method-generic-placeholder",
    ].includes(mode)) {
      if (typeof inner.method !== "string" || !inner.method.includes("prompt")) return false;
      inner.method = mode === "native-binding"
        ? inner.method.replace("prompt", "prompu")
        : mode === "method-unknown"
          ? "PRIVATE_CUSTOMER_METHOD_ALICE"
          : "<STRING_999>";
      return true;
    }
    if (mode === "field-name") {
      if (!inner.params || typeof inner.params !== "object" || Array.isArray(inner.params)) return false;
      inner.params.field_name = "<STRING_1>";
      return true;
    }
    if (mode === "field-cross-context") {
      if (inner.method !== "initialize"
        || !inner.params || typeof inner.params !== "object" || Array.isArray(inner.params)) {
        return false;
      }
      inner.params.options = [];
      return true;
    }
    if (["enum-unknown", "enum-cross-context", "enum-wrong-type"].includes(mode)) {
      if (inner.method !== "session/prompt") return false;
      const blocks = Array.isArray(inner.params?.prompt)
        ? inner.params.prompt
        : inner.params?.content;
      if (!Array.isArray(blocks) || !blocks[0] || typeof blocks[0] !== "object") return false;
      blocks[0].type = mode === "enum-unknown"
        ? "<STRING_999>"
        : mode === "enum-cross-context"
          ? "register"
          : 0;
      return true;
    }
    if (mode === "correlation-numeric") {
      if (typeof inner.id !== "number") return false;
      inner.id = 918273;
      return true;
    }
    inner.id = "<WRONG_LABEL_999>";
    return true;
  });
  if (mode === "capture-cross-context-method") {
    const records = readFileSync(bytesPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (records.length === 0 || records.every((record) => record.capture === "harness-canary")) {
      throw new Error("capture cross-context mutation found no live records");
    }
    for (const record of records) record.capture = "harness-canary";
    writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
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
} else if (mode === "metadata-value-unknown") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) {
    throw new Error("metadata-value-unknown requires BYTES MANIFEST");
  }
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (records.length === 0 || typeof records[0].capture !== "string") {
    throw new Error("metadata value mutation requires a capture record");
  }
  records[0].capture = "PRIVATE_CUSTOMER_CAPTURE_ALICE";
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
} else if (mode === "manifest-capture-profile") {
  const [manifestPath] = args;
  if (!manifestPath) throw new Error("manifest-capture-profile requires MANIFEST");
  const manifest = readJson(manifestPath);
  if (!manifest.captureProfile || typeof manifest.captureProfile.approvalOwner !== "boolean") {
    throw new Error("manifest has no capture profile");
  }
  manifest.captureProfile.approvalOwner = !manifest.captureProfile.approvalOwner;
  writeJson(manifestPath, manifest);
} else if (mode === "env-coherent") {
  const [summaryPath, manifestPath, envKey = "DATABASE_URL"] = args;
  if (!summaryPath || !manifestPath) throw new Error("env-coherent requires SUMMARY MANIFEST");
  if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) throw new Error("env-coherent key is invalid");
  const summary = readJson(summaryPath);
  summary.childEnvKeyNames = [...new Set([...(summary.childEnvKeyNames || []), envKey])].sort();
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
} else if (mode === "approval-raw-byte-metadata-injection") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) {
    throw new Error("approval-raw-byte-metadata-injection requires BYTES MANIFEST");
  }
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const target = records.find((record) => record.capture === "live-approval-owner-matrix");
  if (!target || Object.prototype.hasOwnProperty.call(target, "originalByteLength")) {
    throw new Error("approval safe fixture is not in raw-byte-free form");
  }
  target.originalByteLength = target.sanitizedByteLength;
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "approval-tap-crosslane-metadata") {
  const [bytesPath, manifestPath] = args;
  if (!bytesPath || !manifestPath) {
    throw new Error("approval-tap-crosslane-metadata requires BYTES MANIFEST");
  }
  const records = readFileSync(bytesPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const target = records.find((record) => record.capture === "live-approval-owner-matrix"
    && record.connection === "passive-acp-leader-tap-1"
    && record.direction === "tap_to_real_leader");
  if (!target) throw new Error("approval tap tuple mutation found no target");
  target.role = "real-shared-leader";
  writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, bytesPath);
  writeJson(manifestPath, manifest);
} else if (mode === "exact-transport-summary-count") {
  const [summaryPath, manifestPath] = args;
  if (!summaryPath || !manifestPath) {
    throw new Error("exact-transport-summary-count requires SUMMARY MANIFEST");
  }
  const summary = readJson(summaryPath);
  if (summary.exactOneByteBufferedGateway?.passedTrials !== 100) {
    throw new Error("exact transport summary has no 100-trial pass count");
  }
  summary.exactOneByteBufferedGateway.passedTrials = 99;
  summary.exactOneByteBufferedGateway.failedTrials = 1;
  writeJson(summaryPath, summary);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, summaryPath);
  writeJson(manifestPath, manifest);
} else if (mode === "exact-transport-ledger-count") {
  const [ledgerPath, manifestPath] = args;
  if (!ledgerPath || !manifestPath) {
    throw new Error("exact-transport-ledger-count requires LEDGER MANIFEST");
  }
  const ledger = readJson(ledgerPath);
  if (ledger.passedTrials !== 100 || !Array.isArray(ledger.trials) || ledger.trials.length !== 100) {
    throw new Error("exact transport ledger has no 100-trial pass set");
  }
  ledger.trials[99].clientWriteCallbacks += 1;
  ledger.aggregate.clientWriteCallbacks += 1;
  writeJson(ledgerPath, ledger);
  const manifest = readJson(manifestPath);
  resignFixture(manifest, ledgerPath);
  writeJson(manifestPath, manifest);
} else {
  throw new Error(`unknown mutation mode: ${mode}`);
}
