import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GROK_WIRE_BASELINE,
  isExactGrokWireBaseline,
} from "../lib/grok-wire-baseline.mjs";

const INDEX_SCHEMA = "test223-accepted-live-fixtures/v1";
const OUTPUT_SCHEMA = "test223-live-exact-proposal/v2";
const MANIFEST_SCHEMA = "grok-agent-leader-wire-manifest/v1";
const PROJECTION_SCHEMA = "grok-wire-projection/v1";
const RECORD_SCHEMA = "grok-wire-byte-record/v1";
const ACCEPTED_SCOPE = "live-exact";
const SUPPORTED_TRANSPORTS = new Set(["leader-native-ipc", "acp-stdio"]);
const COMPLETE_STATUSES = new Map([
  ["leader-native-ipc", "complete_native_json"],
  ["acp-stdio", "complete_json"],
]);
const STRUCTURAL_KEYS = new Set([
  "jsonrpc",
  "kind",
  "method",
  "mode",
  "outcome",
  "role",
  "sessionUpdate",
  "session_update",
  "severity",
  "status",
  "stopReason",
  "stop_reason",
  "type",
  "updateType",
  "update_type",
]);
const OPAQUE_SUBTREE_KEYS = new Set([
  "access_token", "account", "apiKey", "api_key", "args", "arguments", "argv",
  "authorization", "availableCommands", "billing", "body", "clientCommands", "command",
  "commandLine", "command_line", "content", "cookie", "cwd", "encryptedContent",
  "encrypted_content", "email", "executable", "filePath", "gitRoot", "history", "input",
  "log", "logs", "message", "output", "password", "path", "payload", "prompt", "prompts",
  "rawInput", "reasoning", "refresh_token", "secret", "serverKey", "sessionSummary",
  "session_summary", "sid", "slash_command", "text", "title", "token", "toolResult",
  "tool_result", "user", "username",
]);
const EXACT_SCALAR_PATHS = new Set([
  "$outer.capabilities.auto_mode",
  "$outer.capabilities.code_nav_enabled",
  "$outer.capabilities.fs_read",
  "$outer.capabilities.fs_write",
  "$outer.capabilities.terminal",
  "$outer.capabilities.yolo_mode",
  "$outer.leader_capabilities.control_v1",
  "$outer.leader_capabilities.relaunch_v1",
  "$outer.leader_capabilities.runtime_cpu_profile",
  "$outer.leader_capabilities.workspace_exposure",
  "$outer.leader_protocol_version",
  "$outer.ready",
  "$rpc.params.clientCapabilities._meta.x.ai/bashOutputNoColor",
  "$rpc.params.clientCapabilities._meta.x.ai/gitHeadChanged",
  "$rpc.params.clientCapabilities._meta.x.ai/incrementalBashOutput",
  "$rpc.params.clientCapabilities.fs.readTextFile",
  "$rpc.params.clientCapabilities.fs.writeTextFile",
  "$rpc.params.clientCapabilities.terminal",
  "$rpc.params.meta.headless",
  "$rpc.params.methodId",
  "$rpc.params.protocolVersion",
  "$rpc.result._meta.cancelRewind",
  "$rpc.result._meta.defaultAuthMethodId",
  "$rpc.result._meta.grokShell",
  "$rpc.result._meta.mcpApps",
  "$rpc.result._meta.sessionRecap",
  "$rpc.result._meta.x.ai/mcp/sdk",
  "$rpc.result._meta.x.ai/pluginDirs",
  "$rpc.result.agentCapabilities._meta.x.ai/fs_notify",
  "$rpc.result.agentCapabilities.loadSession",
  "$rpc.result.agentCapabilities.mcpCapabilities.http",
  "$rpc.result.agentCapabilities.mcpCapabilities.sse",
  "$rpc.result.agentCapabilities.promptCapabilities.audio",
  "$rpc.result.agentCapabilities.promptCapabilities.embeddedContext",
  "$rpc.result.agentCapabilities.promptCapabilities.image",
  "$rpc.result.authMethods[].id",
  "$rpc.result.protocolVersion",
]);
const STRUCTURAL_PLACEHOLDER = /^<(?:METHOD|STRING)_\d+>$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_STEM = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function fail(message) {
  throw new Error(message);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonical(actual) !== canonical(wanted)) {
    fail(`${label} fields differ from schema`);
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is not a sha256`);
}

function parseCli(argv) {
  if (argv.length < 3) {
    fail("usage: compile-accepted-live-exact-shapes.mjs INDEX ARTIFACT_ROOT OUTPUT --expected-index-sha256 HASH --project SCRIPT");
  }
  const [indexPath, artifactRoot, outputPath, ...flags] = argv;
  let expectedIndexSha256;
  let projectPath;
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!value || !["--expected-index-sha256", "--project"].includes(flag)) {
      fail("compiler flags are incomplete or unsupported");
    }
    if (flag === "--expected-index-sha256") {
      if (expectedIndexSha256 !== undefined) fail("expected index pin was provided twice");
      expectedIndexSha256 = value;
    } else {
      if (projectPath !== undefined) fail("project script was provided twice");
      projectPath = value;
    }
  }
  assertSha(expectedIndexSha256, "expected index pin");
  if (!projectPath) fail("project script is required");
  return { indexPath, artifactRoot, outputPath, expectedIndexSha256, projectPath };
}

function regularNonSymlink(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`${label} does not exist`);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
}

function makeRootGuard(rootInput) {
  let rootInfo;
  try {
    rootInfo = lstatSync(resolve(rootInput));
  } catch {
    fail("artifact root does not exist");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    fail("artifact root must be a non-symlink directory");
  }
  const root = realpathSync(resolve(rootInput));
  return (relativePath, label) => {
    if (typeof relativePath !== "string" || relativePath.length === 0
      || isAbsolute(relativePath) || relativePath.includes("\\")) {
      fail(`${label} path must be a portable relative path`);
    }
    const pieces = relativePath.split("/");
    if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) {
      fail(`${label} path is not normalized`);
    }
    let cursor = root;
    for (const piece of pieces) {
      cursor = join(cursor, piece);
      let info;
      try {
        info = lstatSync(cursor);
      } catch {
        fail(`${label} does not exist`);
      }
      if (info.isSymbolicLink()) fail(`${label} path must not traverse a symlink`);
    }
    regularNonSymlink(cursor, label);
    const resolved = realpathSync(cursor);
    const rel = relative(root, resolved);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      fail(`${label} resolves outside artifact root`);
    }
    return resolved;
  };
}

function pathFromRoot(root, absolutePath, label) {
  const resolved = realpathSync(resolve(absolutePath));
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${label} must be below artifact root`);
  }
  return rel.split(sep).join("/");
}

function validateFileRef(ref, label, resolveEntryPath) {
  exactKeys(ref, ["path", "sha256"], label);
  assertSha(ref.sha256, `${label}.sha256`);
  const path = resolveEntryPath(ref.path, label);
  const actual = sha256File(path);
  if (actual !== ref.sha256) fail(`${label} hash differs from accepted index`);
  return path;
}

function manifestFileMap(manifest, label) {
  if (!Array.isArray(manifest.fixtureFiles)) fail(`${label}.fixtureFiles must be an array`);
  const map = new Map();
  for (const item of manifest.fixtureFiles) {
    exactKeys(item, ["path", "sha256"], `${label}.fixtureFiles entry`);
    assertSha(item.sha256, `${label}.fixtureFiles sha256`);
    if (map.has(item.path)) fail(`${label}.fixtureFiles has a duplicate path`);
    map.set(item.path, item.sha256);
  }
  return map;
}

function manifestSourceMap(manifest, label) {
  if (!Array.isArray(manifest.harnessSourceFiles)) {
    fail(`${label}.harnessSourceFiles must be an array`);
  }
  const map = new Map();
  for (const item of manifest.harnessSourceFiles) {
    exactKeys(item, ["path", "sha256"], `${label}.harnessSourceFiles entry`);
    assertSha(item.sha256, `${label}.harnessSourceFiles sha256`);
    if (map.has(item.path)) fail(`${label}.harnessSourceFiles has a duplicate path`);
    map.set(item.path, item.sha256);
  }
  return map;
}

function manifestSourceHash(sourceMap, rootRelativePath, label) {
  const matches = [...sourceMap]
    .filter(([path]) => rootRelativePath === path || rootRelativePath.endsWith(`/${path}`));
  if (matches.length !== 1) fail(`${label} is not uniquely bound by manifest source metadata`);
  return matches[0][1];
}

function typedId(value) {
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${Object.is(value, -0) ? "-0" : JSON.stringify(value)}`;
  }
  return undefined;
}

function reverseDirection(direction) {
  if (typeof direction !== "string") return undefined;
  const marker = "_to_";
  const offset = direction.indexOf(marker);
  if (offset <= 0 || offset !== direction.lastIndexOf(marker)) return undefined;
  const source = direction.slice(0, offset);
  const destination = direction.slice(offset + marker.length);
  return source && destination ? `${destination}${marker}${source}` : undefined;
}

function messageKind(rpc) {
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc)) fail("RPC payload is not an object");
  if (typeof rpc.method === "string") {
    return Object.prototype.hasOwnProperty.call(rpc, "id") ? "request" : "notification";
  }
  if (Object.prototype.hasOwnProperty.call(rpc, "id")
    && (Object.prototype.hasOwnProperty.call(rpc, "result")
      || Object.prototype.hasOwnProperty.call(rpc, "error"))) return "response";
  fail("accepted projection contains an unresolved RPC message kind");
}

function assertExactStructuralScalar(value, path, key) {
  const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
  if (!scalar) fail(`exact structural scalar at ${path} is not scalar`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail(`exact structural scalar at ${path} is not finite`);
  }
  if (typeof value === "string"
    && (STRUCTURAL_PLACEHOLDER.test(value) || value === "unresolved")) {
    fail(`unreviewed structural placeholder at ${path} (${key ?? "path"})`);
  }
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value;
  fail("projection contains a non-JSON protocol value");
}

function collectShape(value, root) {
  const paths = [];
  const exactScalars = [];
  const visit = (current, path, key, opaque = false) => {
    const type = valueType(current);
    paths.push({ path, type });
    const childOpaque = opaque || OPAQUE_SUBTREE_KEYS.has(key);
    if (type === "array") {
      for (const child of current) visit(child, `${path}[]`, undefined, childOpaque);
      return;
    }
    if (type === "object") {
      for (const childKey of Object.keys(current).sort()) {
        if (childOpaque && !STRUCTURAL_KEYS.has(childKey)) continue;
        visit(current[childKey], `${path}.${childKey}`, childKey, childOpaque);
      }
      return;
    }
    if (STRUCTURAL_KEYS.has(key) || EXACT_SCALAR_PATHS.has(path)) {
      assertExactStructuralScalar(current, path, key);
      exactScalars.push({ path, value: current });
    }
  };
  visit(value, root, undefined);
  const pathMap = new Map();
  for (const entry of paths) pathMap.set(canonical(entry), entry);
  return {
    paths: [...pathMap.values()].sort((left, right) => left.path.localeCompare(right.path)
      || left.type.localeCompare(right.type)),
    exactScalars,
  };
}

function parseProjection(path, entry) {
  const text = readFileSync(path, "utf8");
  if (text.length === 0 || !text.endsWith("\n")) {
    fail(`${entry.id} projection must be non-empty newline-terminated NDJSON`);
  }
  const rows = [];
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail(`${entry.id} projection line ${lineIndex + 1} is invalid JSON`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)
      || row.schema !== PROJECTION_SCHEMA) {
      fail(`${entry.id} projection line ${lineIndex + 1} has an unsupported schema`);
    }
    if (row.capture !== entry.capture) fail(`${entry.id} projection capture differs from index`);
    if (!SUPPORTED_TRANSPORTS.has(row.transport)) continue;
    if (row.parseStatus === "clean_eof") continue;
    if (row.parseStatus !== COMPLETE_STATUSES.get(row.transport)) {
      fail(`${entry.id} accepted projection contains an incomplete protocol frame`);
    }
    if (typeof row.connection !== "string" || typeof row.direction !== "string"
      || !Number.isSafeInteger(row.frameIndex) || !Array.isArray(row.recordSeqs)
      || row.recordSeqs.some((seq) => !Number.isSafeInteger(seq))) {
      fail(`${entry.id} projection frame metadata is incomplete`);
    }
    let outer;
    let rpc;
    if (row.transport === "leader-native-ipc") {
      if (!row.outer || typeof row.outer !== "object" || Array.isArray(row.outer)
        || typeof row.outer.type !== "string") {
        fail(`${entry.id} native projection has no exact outer message`);
      }
      outer = row.outer;
      assertExactStructuralScalar(outer.type, "$outer.type", "type");
      if (outer.type === "acp") {
        if (!row.inner || typeof row.inner !== "object" || Array.isArray(row.inner)) {
          fail(`${entry.id} native ACP projection has no inner RPC`);
        }
        let independentlyParsed;
        if (typeof outer.payload === "string") {
          try {
            independentlyParsed = JSON.parse(outer.payload);
          } catch {
            fail(`${entry.id} native ACP outer payload is invalid JSON`);
          }
        } else if (outer.payload && typeof outer.payload === "object"
          && !Array.isArray(outer.payload)) {
          independentlyParsed = outer.payload;
        } else {
          fail(`${entry.id} native ACP outer payload is malformed`);
        }
        if (canonical(independentlyParsed) !== canonical(row.inner)) {
          fail(`${entry.id} native ACP inner projection differs from outer payload`);
        }
        rpc = row.inner;
      } else if (row.inner !== undefined) {
        fail(`${entry.id} non-ACP outer frame unexpectedly has an inner RPC`);
      }
    } else {
      if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
        fail(`${entry.id} ACP stdio projection has no RPC payload`);
      }
      rpc = row.payload;
    }
    rows.push({
      row,
      outer,
      rpc,
      messageKind: rpc === undefined ? "outer-message" : messageKind(rpc),
      order: Math.min(...row.recordSeqs),
    });
  }
  if (rows.length === 0) fail(`${entry.id} projection contains no supported complete frames`);
  return rows;
}

function validateSafeBytes(path, entry) {
  const text = readFileSync(path, "utf8");
  if (text.length === 0 || !text.endsWith("\n")) {
    fail(`${entry.id} bytes fixture must be non-empty newline-terminated NDJSON`);
  }
  let supported = 0;
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(`${entry.id} bytes line ${lineIndex + 1} is invalid JSON`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || record.schema !== RECORD_SCHEMA) {
      fail(`${entry.id} bytes line ${lineIndex + 1} has an unsupported schema`);
    }
    if (record.capture !== entry.capture) fail(`${entry.id} bytes capture differs from index`);
    if (SUPPORTED_TRANSPORTS.has(record.transport)) supported += 1;
  }
  if (supported === 0) fail(`${entry.id} bytes fixture has no supported transport records`);
}

function correlate(rows, entry) {
  const queues = new Map();
  const ordered = [...rows].sort((left, right) =>
    left.row.connection.localeCompare(right.row.connection)
      || left.order - right.order
      || left.row.frameIndex - right.row.frameIndex
      || left.row.direction.localeCompare(right.row.direction));
  for (const frame of ordered) {
    if (frame.messageKind === "outer-message") continue;
    const id = typedId(frame.rpc.id);
    if (frame.messageKind === "request") {
      if (id === undefined) fail(`${entry.id} request has an unsupported id`);
      assertExactStructuralScalar(frame.rpc.method, "$rpc.method", "method");
      const key = canonical([
        frame.row.transport,
        frame.row.connection,
        frame.row.direction,
        id,
      ]);
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(frame.rpc.method);
      frame.correlatedMethod = frame.rpc.method;
    } else if (frame.messageKind === "notification") {
      assertExactStructuralScalar(frame.rpc.method, "$rpc.method", "method");
      frame.correlatedMethod = frame.rpc.method;
    } else {
      const opposite = reverseDirection(frame.row.direction);
      if (id === undefined || !opposite) fail(`${entry.id} response cannot be correlated`);
      const key = canonical([
        frame.row.transport,
        frame.row.connection,
        opposite,
        id,
      ]);
      const pending = queues.get(key);
      const method = pending?.shift();
      if (!method) fail(`${entry.id} response method correlation is unresolved`);
      frame.correlatedMethod = method;
    }
  }
  return rows;
}

function deriveShapes(rows, entry) {
  correlate(rows, entry);
  const selectors = [];
  for (const frame of rows) {
    const outerType = frame.row.transport === "acp-stdio"
      ? "not-applicable"
      : frame.outer.type;
    assertExactStructuralScalar(outerType, "$selector.outerType", "type");
    const selector = {
      transport: frame.row.transport,
      outerType,
      messageKind: frame.messageKind,
      ...(frame.messageKind === "outer-message" ? {} : { method: frame.correlatedMethod }),
    };
    if (selector.method !== undefined) {
      assertExactStructuralScalar(selector.method, "$selector.method", "method");
    }
    const pieces = [];
    if (frame.outer !== undefined) pieces.push(collectShape(frame.outer, "$outer"));
    if (frame.rpc !== undefined) pieces.push(collectShape(frame.rpc, "$rpc"));
    const paths = pieces.flatMap((piece) => piece.paths)
      .sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
    const scalarMap = new Map();
    for (const scalar of pieces.flatMap((piece) => piece.exactScalars)) {
      if (!scalarMap.has(scalar.path)) scalarMap.set(scalar.path, new Map());
      scalarMap.get(scalar.path).set(canonical(scalar.value), scalar.value);
    }
    const exactScalars = [...scalarMap]
      .map(([path, values]) => ({
        path,
        values: [...values.values()].sort((left, right) => canonical(left).localeCompare(canonical(right))),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    selectors.push({
      selector,
      shape: { paths, exactScalars },
      source: {
        sourceId: entry.id,
        stem: entry.stem,
        capture: entry.capture,
        projectionSha256: entry.projection.sha256,
        connection: frame.row.connection,
        direction: frame.row.direction,
        frameIndex: frame.row.frameIndex,
      },
    });
  }
  return selectors;
}

function mergeDerived(all) {
  const selectorMap = new Map();
  for (const item of all) {
    const selectorKey = canonical(item.selector);
    if (!selectorMap.has(selectorKey)) {
      selectorMap.set(selectorKey, { selector: item.selector, shapes: new Map() });
    }
    // Exact scalar combinations are part of the shape identity.  Merging only
    // on paths and unioning values per path would admit an unobserved Cartesian
    // product across otherwise correlated protocol literals.
    const shapeKey = canonical({
      paths: item.shape.paths,
      exactScalars: item.shape.exactScalars,
    });
    const container = selectorMap.get(selectorKey);
    if (!container.shapes.has(shapeKey)) {
      container.shapes.set(shapeKey, {
        paths: item.shape.paths,
        exactScalars: item.shape.exactScalars,
        sources: new Map(),
      });
    }
    const shape = container.shapes.get(shapeKey);
    shape.sources.set(canonical(item.source), item.source);
  }
  return [...selectorMap.values()]
    .map(({ selector, shapes }) => ({
      selector,
      shapes: [...shapes.values()]
        .map((shape) => ({
          paths: shape.paths,
          exactScalars: shape.exactScalars,
          sources: [...shape.sources.values()]
            .sort((left, right) => canonical(left).localeCompare(canonical(right))),
        }))
        .sort((left, right) => canonical({
          paths: left.paths,
          exactScalars: left.exactScalars,
        }).localeCompare(canonical({
          paths: right.paths,
          exactScalars: right.exactScalars,
        }))),
    }))
    .sort((left, right) => canonical(left.selector).localeCompare(canonical(right.selector)));
}

function freshProject(projectPath, bytesPath, savedProjectionPath, root) {
  const temp = mkdtempSync(join(tmpdir(), "test223-accepted-project-"));
  const output = join(temp, "fresh.projection.ndjson");
  try {
    const result = spawnSync(process.execPath, [projectPath, bytesPath, output], {
      cwd: root,
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      fail(`fresh projection failed: ${result.error?.message || result.stderr.trim() || result.status}`);
    }
    regularNonSymlink(output, "fresh projection output");
    if (!readFileSync(output).equals(readFileSync(savedProjectionPath))) {
      fail("fresh projection differs byte-for-byte from accepted projection");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function validateEntry(entry, context) {
  exactKeys(entry, [
    "id", "acceptedScopes", "stem", "capture", "bytes", "projection", "summary",
    "manifest", "sourceScript", "sanitizer", "projector", "grokBinary",
  ], `accepted entry ${entry?.id ?? "<unknown>"}`);
  if (typeof entry.id !== "string" || !SAFE_ID.test(entry.id)) fail("accepted entry id is unsafe");
  if (!Array.isArray(entry.acceptedScopes) || entry.acceptedScopes.length === 0
    || entry.acceptedScopes.some((scope) => typeof scope !== "string")
    || canonical(entry.acceptedScopes) !== canonical([...new Set(entry.acceptedScopes)].sort())) {
    fail(`${entry.id} acceptedScopes must be sorted and unique`);
  }
  if (!SAFE_STEM.test(entry.stem)) fail(`${entry.id} stem is unsafe`);
  if (typeof entry.capture !== "string" || entry.capture.length === 0
    || STRUCTURAL_PLACEHOLDER.test(entry.capture) || entry.capture === "unresolved") {
    fail(`${entry.id} capture is not exact`);
  }
  exactKeys(entry.grokBinary,
    ["semver", "build", "binarySha256", "versionRawBase64Sha256"],
    `${entry.id}.grokBinary`);
  if (typeof entry.grokBinary.semver !== "string" || typeof entry.grokBinary.build !== "string") {
    fail(`${entry.id} Grok version metadata is malformed`);
  }
  assertSha(entry.grokBinary.binarySha256, `${entry.id}.grokBinary.binarySha256`);
  assertSha(entry.grokBinary.versionRawBase64Sha256,
    `${entry.id}.grokBinary.versionRawBase64Sha256`);

  const bytesPath = validateFileRef(entry.bytes, `${entry.id}.bytes`, context.resolveEntryPath);
  const projectionPath = validateFileRef(
    entry.projection,
    `${entry.id}.projection`,
    context.resolveEntryPath,
  );
  const summaryPath = validateFileRef(entry.summary, `${entry.id}.summary`, context.resolveEntryPath);
  const manifestPath = validateFileRef(entry.manifest, `${entry.id}.manifest`, context.resolveEntryPath);
  validateFileRef(
    entry.sourceScript,
    `${entry.id}.sourceScript`,
    context.resolveEntryPath,
  );
  validateFileRef(
    entry.sanitizer,
    `${entry.id}.sanitizer`,
    context.resolveEntryPath,
  );
  const projectorPath = validateFileRef(
    entry.projector,
    `${entry.id}.projector`,
    context.resolveEntryPath,
  );

  if (basename(entry.bytes.path) !== `${entry.stem}.bytes.ndjson`
    || basename(entry.projection.path) !== `${entry.stem}.projection.ndjson`
    || basename(entry.summary.path) !== `${entry.stem}.summary.json`
    || basename(entry.manifest.path) !== "manifest.json") {
    fail(`${entry.id} stem does not bind the expected artifact filenames`);
  }
  const artifactDirectory = dirname(entry.bytes.path);
  if ([entry.projection.path, entry.summary.path, entry.manifest.path]
    .some((path) => dirname(path) !== artifactDirectory)) {
    fail(`${entry.id} accepted artifact files are not in one directory`);
  }
  if (realpathSync(projectorPath) !== context.projectPath) {
    fail(`${entry.id} projector differs from --project script`);
  }

  const manifest = parseJsonFile(manifestPath, `${entry.id} manifest`);
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`${entry.id} manifest schema is unsupported`);
  if (manifest.protocolFreeze !== false) fail(`${entry.id} manifest must not self-assert protocol freeze`);
  const fixtures = manifestFileMap(manifest, `${entry.id} manifest`);
  for (const ref of [entry.bytes, entry.projection, entry.summary]) {
    if (fixtures.get(basename(ref.path)) !== ref.sha256) {
      fail(`${entry.id} manifest does not bind ${basename(ref.path)}`);
    }
  }
  const sources = manifestSourceMap(manifest, `${entry.id} manifest`);
  for (const [ref, label] of [
    [entry.sourceScript, "sourceScript"],
    [entry.sanitizer, "sanitizer"],
    [entry.projector, "projector"],
  ]) {
    const rootRelative = context.rootRelative(ref.path);
    if (manifestSourceHash(sources, rootRelative, `${entry.id}.${label}`) !== ref.sha256) {
      fail(`${entry.id} manifest source hash differs for ${label}`);
    }
  }
  if (manifest.redactionToolSha256 !== entry.sanitizer.sha256
    || manifest.projectorSha256 !== entry.projector.sha256) {
    fail(`${entry.id} manifest sanitizer/projector metadata differs from index`);
  }
  if (!manifest.grok || manifest.grok.supplied !== true
    || manifest.grok.normalizedVersion?.semver !== entry.grokBinary.semver
    || manifest.grok.normalizedVersion?.build !== entry.grokBinary.build
    || manifest.grok.binarySha256 !== entry.grokBinary.binarySha256
    || typeof manifest.grok.versionRawBase64 !== "string") {
    fail(`${entry.id} manifest Grok binary metadata differs from index`);
  }
  if (!isExactGrokWireBaseline({
    product: "grok",
    semver: entry.grokBinary.semver,
    build: entry.grokBinary.build,
    binarySha256: entry.grokBinary.binarySha256,
  })) {
    fail(`${entry.id} Grok binary differs from the fixed Phase 0 baseline`);
  }
  let rawVersion;
  try {
    rawVersion = Buffer.from(manifest.grok.versionRawBase64, "base64");
  } catch {
    fail(`${entry.id} manifest Grok version metadata is invalid base64`);
  }
  if (rawVersion.toString("base64") !== manifest.grok.versionRawBase64
    || sha256Bytes(rawVersion) !== entry.grokBinary.versionRawBase64Sha256) {
    fail(`${entry.id} Grok version output hash differs from index`);
  }

  const summary = parseJsonFile(summaryPath, `${entry.id} summary`);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || summary.ok !== true || summary.protocolFreeze !== false) {
    fail(`${entry.id} summary is not a successful unfrozen live summary`);
  }
  const expectedVersion = `grok ${entry.grokBinary.semver} (${entry.grokBinary.build})`;
  if (summary.grokVersion !== undefined && summary.grokVersion !== expectedVersion) {
    fail(`${entry.id} summary Grok version differs from index`);
  }
  if (summary.pinnedBinarySha256 !== undefined
    && summary.pinnedBinarySha256 !== entry.grokBinary.binarySha256) {
    fail(`${entry.id} summary Grok binary hash differs from index`);
  }

  validateSafeBytes(bytesPath, entry);
  freshProject(projectorPath, bytesPath, projectionPath, context.root);
  const rows = parseProjection(projectionPath, entry);
  return deriveShapes(rows, entry);
}

const cli = parseCli(process.argv.slice(2));
regularNonSymlink(resolve(cli.indexPath), "accepted index");
const indexBytes = readFileSync(resolve(cli.indexPath));
const actualIndexSha256 = sha256Bytes(indexBytes);
if (actualIndexSha256 !== cli.expectedIndexSha256) {
  fail("accepted index digest differs from external reviewer pin");
}
let acceptedIndex;
try {
  acceptedIndex = JSON.parse(indexBytes.toString("utf8"));
} catch {
  fail("accepted index is not valid JSON");
}
exactKeys(acceptedIndex, [
  "schema", "acceptancePolicy", "reviewerExternalPinRequired", "ownerMayAddAcceptedEntries",
  "entries",
], "accepted index");
if (acceptedIndex.schema !== INDEX_SCHEMA
  || acceptedIndex.acceptancePolicy !== "external-reviewer-pinned-index-sha256"
  || acceptedIndex.reviewerExternalPinRequired !== true
  || acceptedIndex.ownerMayAddAcceptedEntries !== false
  || !Array.isArray(acceptedIndex.entries)) {
  fail("accepted index policy is unsupported");
}

const rootInput = resolve(cli.artifactRoot);
const rootInfo = lstatSync(rootInput);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
  fail("artifact root must be a non-symlink directory");
}
const root = realpathSync(rootInput);
const resolveEntryPath = makeRootGuard(root);
regularNonSymlink(resolve(cli.projectPath), "project script");
const projectPath = realpathSync(resolve(cli.projectPath));
pathFromRoot(root, projectPath, "project script");
const liveEntries = acceptedIndex.entries.filter((entry) =>
  Array.isArray(entry?.acceptedScopes) && entry.acceptedScopes.includes(ACCEPTED_SCOPE));
const ids = new Set();
const derived = [];
for (const entry of liveEntries) {
  if (ids.has(entry.id)) fail("accepted index contains a duplicate live entry id");
  ids.add(entry.id);
  derived.push(...validateEntry(entry, {
    root,
    projectPath,
    resolveEntryPath,
    rootRelative(path) {
      return pathFromRoot(root, resolveEntryPath(path, "accepted source"), "accepted source");
    },
  }));
}
const sourceIds = [...ids].sort();
const output = {
  schema: OUTPUT_SCHEMA,
  status: "non_authorizing_v2_proposal",
  authorizesAcceptedMode: false,
  source: "reviewer-index-union-proposal",
  namespace: GROK_WIRE_BASELINE,
  acceptedIndexSha256: actualIndexSha256,
  opaqueSubtreeKeys: [...OPAQUE_SUBTREE_KEYS].sort(),
  opaqueStructuralKeys: [...STRUCTURAL_KEYS].sort(),
  sourceIds,
  selectors: mergeDerived(derived),
};
mkdirSync(dirname(resolve(cli.outputPath)), { recursive: true });
writeFileSync(resolve(cli.outputPath), `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
