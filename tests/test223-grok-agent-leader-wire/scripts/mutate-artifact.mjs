import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: mutate-artifact.mjs SAFE_BYTES_NDJSON");

const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const bytes = Buffer.concat([
  Buffer.from(records[0].bytesBase64, "base64"),
  Buffer.from("CAPTURE_TOKEN_CANARY_MUTATION"),
]);
records[0].bytesBase64 = bytes.toString("base64");
records[0].sanitizedByteLength = bytes.length;
records[0].sanitizedBytesSha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
