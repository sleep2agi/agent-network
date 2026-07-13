import { appendFileSync, closeSync, constants, openSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/**
 * Exact byte-boundary recorder for Phase 0 scenarios.
 *
 * Callers must place outputPath under the tmpfs RAW_DIR. Payload bytes must not
 * be copied into metadata, logs, exceptions, or stdout. One call to record()
 * represents one OS/process read or write callback.
 */
export class ByteRecorder {
  constructor(outputPath, capture, fixed = {}, options = {}) {
    const rawRootInput = process.env.RAW_DIR;
    if (!rawRootInput) throw new Error("RAW_DIR is required for unredacted capture");
    const rawRoot = realpathSync(resolve(rawRootInput));
    const outputParent = realpathSync(dirname(resolve(outputPath)));
    const rel = relative(rawRoot, outputParent);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      throw new Error("unredacted capture path escapes RAW_DIR");
    }
    this.outputPath = outputPath;
    this.capture = capture;
    this.fixed = structuredClone(fixed);
    this.sequence = 0;
    this.now = options.now || (() => process.hrtime.bigint());
    this.started = this.now();
    this.fd = openSync(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  }

  record({ role, transport, connection, stream, direction, boundary, bytes, ...metadata }) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new TypeError("record bytes must be a Buffer or Uint8Array");
    }
    const payload = Buffer.from(bytes);
    const record = {
      schema: "grok-wire-byte-record/v1",
      capture: this.capture,
      seq: ++this.sequence,
      monoNs: String(this.now() - this.started),
      role,
      transport,
      connection,
      stream,
      direction,
      boundary,
      ...this.fixed,
      ...metadata,
      encoding: "base64",
      originalByteLength: payload.length,
      bytesBase64: payload.toString("base64"),
    };
    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
  }

  close() {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }
}
