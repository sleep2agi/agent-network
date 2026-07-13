import {
  lstatSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const MAX_FRAME_BYTES = 1024 * 1024;
const [mode, input] = process.argv.slice(2);
const MODES = new Set([
  "method-unknown",
  "enum-unknown",
  "enum-cross-context",
  "enum-wrong-type",
]);
if (!MODES.has(mode) || !input) {
  throw new Error(
    `usage: mutate-raw-live-protocol.mjs ${[...MODES].join("|")} RAW_NDJSON`,
  );
}

function fail(message) {
  throw new Error(message);
}

function assertRawPath(path) {
  if (!process.env.RAW_DIR) fail("RAW_DIR is required");
  const rawDirInput = resolve(process.env.RAW_DIR);
  const inputPath = resolve(path);
  if (lstatSync(rawDirInput).isSymbolicLink() || lstatSync(inputPath).isSymbolicLink()) {
    fail("raw mutation paths must not be symlinks");
  }
  const rawDir = realpathSync(rawDirInput);
  const realInput = realpathSync(inputPath);
  const rel = relative(rawDir, realInput);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    fail("raw mutation input must be below RAW_DIR");
  }
  if (Number(statfsSync(rawDir).type) !== TMPFS_MAGIC
    || Number(statfsSync(realInput).type) !== TMPFS_MAGIC) {
    fail("raw mutation input must remain on tmpfs");
  }
  return realInput;
}

const inputPath = assertRawPath(input);
const records = readFileSync(inputPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const groups = new Map();
for (const record of records) {
  if (record.schema !== "grok-wire-byte-record/v1"
    || record.encoding !== "base64"
    || record.transport !== "leader-native-ipc") continue;
  const key = [record.capture, record.connection, record.stream, record.direction].join("\u0000");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

let changed = false;
for (const group of groups.values()) {
  group.sort((left, right) => left.seq - right.seq);
  const source = Buffer.concat(group.map((record) => Buffer.from(record.bytesBase64, "base64")));
  const output = [];
  let cursor = 0;
  let groupChanged = false;
  while (cursor < source.length) {
    if (source.length - cursor < 4) {
      output.push(source.subarray(cursor));
      cursor = source.length;
      break;
    }
    const length = source.readUInt32BE(cursor);
    if (length > MAX_FRAME_BYTES || source.length - cursor - 4 < length) {
      output.push(source.subarray(cursor));
      cursor = source.length;
      break;
    }
    const payload = source.subarray(cursor + 4, cursor + 4 + length);
    cursor += 4 + length;
    let rewritten = payload;
    try {
      const outer = JSON.parse(payload.toString("utf8"));
      if (!changed && outer?.type === "acp") {
        const stringPayload = typeof outer.payload === "string";
        const rpc = stringPayload ? JSON.parse(outer.payload) : outer.payload;
        if (rpc?.method === "session/prompt" && rpc.params
          && typeof rpc.params === "object" && !Array.isArray(rpc.params)) {
          let eligible = true;
          if (mode === "method-unknown") {
            rpc.method = "PRIVATE_CUSTOMER_METHOD_ALICE";
          } else {
            const blocks = Array.isArray(rpc.params.prompt)
              ? rpc.params.prompt
              : rpc.params.content;
            if (Array.isArray(blocks) && blocks[0]
              && typeof blocks[0] === "object" && !Array.isArray(blocks[0])) {
              blocks[0].type = mode === "enum-unknown"
                ? "PRIVATE_CUSTOMER_BLOCK_ALICE"
                : mode === "enum-cross-context"
                  ? "register"
                  : 0;
            } else {
              eligible = false;
            }
          }
          if (eligible) {
            outer.payload = stringPayload ? JSON.stringify(rpc) : rpc;
            rewritten = Buffer.from(JSON.stringify(outer));
            changed = true;
            groupChanged = true;
          }
        }
      }
    } catch {
      // Only a complete, parsed native ACP frame is an eligible control.
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(rewritten.length);
    output.push(header, rewritten);
  }
  if (!groupChanged) continue;

  const rewrittenStream = Buffer.concat(output);
  const dataRecords = group.filter((record) => Buffer.from(record.bytesBase64, "base64").length > 0);
  if (dataRecords.length === 0) fail("eligible native stream has no data records");
  let outputOffset = 0;
  for (const [index, record] of dataRecords.entries()) {
    const originalLength = Buffer.from(record.bytesBase64, "base64").length;
    const final = index === dataRecords.length - 1;
    const end = final
      ? rewrittenStream.length
      : Math.min(rewrittenStream.length, outputOffset + originalLength);
    const bytes = rewrittenStream.subarray(outputOffset, end);
    outputOffset = end;
    record.bytesBase64 = bytes.toString("base64");
    record.originalByteLength = bytes.length;
  }
  if (outputOffset !== rewrittenStream.length) fail("raw mutation repartition lost bytes");
  break;
}

if (!changed) fail(`no eligible live session/prompt frame for ${mode}`);
writeFileSync(inputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
  mode: 0o600,
});
