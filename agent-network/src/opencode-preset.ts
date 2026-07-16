// RFC-029 PR③ — opencode vendor preset registry + auth.json writer.
//
// Preset choices covered here (per RFC-029 §8 D3, 通信龙 拍板):
//
//   anthropic — Anthropic 原生 API. opencode's built-in Anthropic
//               client uses `x-api-key`; reads key from env
//               `ANTHROPIC_API_KEY`. Any Bearer-only vendor gateway
//               (Kimi coding etc.) is a plugin-track backlog item.
//   openai    — OpenAI. Uses `OPENAI_API_KEY`.
//
// The auth.json file is written to `<nodeWorkDir>/.local/share/
// opencode/auth.json` (opencode's per-node config root) with mode
// 0o600. The API key is READ FROM ENV — per 通信龙 PR③
// refinement 2, we don't prompt for it.
//
// Important security boundary: mode 0o600 protects against other OS
// users, not another process running as the same uid. OpenCode's tool
// permissions are likewise a safe default for model-driven tool use,
// not a process sandbox. The runtime must still pass a minimal child
// environment and operators must reserve the unsafe-tools opt-in for
// trusted tasks in an OS/container sandbox.

import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { opencodeOwnedPathModeIsSafe } from "./opencode-owner-mode";

export type OpencodePresetId = "anthropic" | "openai";

export interface OpencodePreset {
  id: OpencodePresetId;
  displayName: string;
  envKey: string;
  signupUrl: string;
  /** How opencode's provider config identifies this vendor in the
   *  `provider.<id>.options.baseUrl` config. Left null when we don't
   *  need to override the built-in default. */
  configProviderId: "anthropic" | "openai";
}

export const OPENCODE_PRESETS: OpencodePreset[] = [
  {
    id: "anthropic",
    displayName: "Anthropic 原生 API (claude.ai)",
    envKey: "ANTHROPIC_API_KEY",
    signupUrl: "https://console.anthropic.com/settings/keys",
    configProviderId: "anthropic",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    signupUrl: "https://platform.openai.com/api-keys",
    configProviderId: "openai",
  },
];

/**
 * OpenCode tools disabled for the default `opencode-cli` profile.
 *
 * This policy reduces the model's ambient filesystem/shell surface. It is
 * deliberately represented in the generated opencode.json so operators can
 * inspect the default, but it is not an OS security boundary: a same-uid
 * OpenCode process can still read files allowed by normal filesystem ACLs.
 */
export const OPENCODE_DEFAULT_DISABLED_TOOLS = [
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "list",
  "task",
  "skill",
  // Safe preview is text-only: exact 1.18.1's web tools permit loopback,
  // link-local, and private-network URLs, so leaving them enabled is SSRF.
  "webfetch",
  "websearch",
  // OpenCode's ACP `question` tool requires an interactive client response.
  // agent-node is unattended and intentionally exposes no question UI, so a
  // model call would otherwise wait forever.
  "question",
] as const;

export function buildOpencodeDefaultToolsPolicy(): Record<string, false> {
  return Object.fromEntries(
    OPENCODE_DEFAULT_DISABLED_TOOLS.map((tool) => [tool, false] as const),
  );
}

export function buildOpencodeDefaultPermissionPolicy(): Record<string, "deny"> {
  return {
    "*": "deny",
    ...Object.fromEntries(
      OPENCODE_DEFAULT_DISABLED_TOOLS.map((tool) => [tool, "deny"] as const),
    ),
    external_directory: "deny",
    doom_loop: "deny",
  };
}

export function findOpencodePreset(id: string): OpencodePreset | null {
  return OPENCODE_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Look up the API key for a preset from the current process env.
 * Callers MUST handle the `null` case (per RFC v0.3 D3 + 通信龙 PR③
 * flag: "从 env 读, 别 prompt"). Returns null so the wizard can
 * emit a clear message telling the operator to export the env var
 * and re-run — rather than silently continuing without a key.
 */
export function readPresetKeyFromEnv(preset: OpencodePreset, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[preset.envKey];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/**
 * opencode.ai's auth.json shape:
 *   { "<providerId>": { "type": "api", "key": "..." } }
 * Same shape verified against the release pin opencode-ai@1.18.1.
 */
export function buildAuthJsonBody(preset: OpencodePreset, apiKey: string): string {
  const body: Record<string, unknown> = {
    [preset.configProviderId]: { type: "api", key: apiKey },
  };
  return JSON.stringify(body, null, 2) + "\n";
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`OpenCode preset refuses ${label}: path escapes node workDir`);
}

function assertPrivateDirectory(path: string, label: string, created = false): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`OpenCode preset refuses ${label} at ${path}: expected a canonical real directory`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isDirectory() || current.isSymbolicLink() || !sameIdentity(before, opened)
      || !sameIdentity(opened, current) || realpathSync(path) !== path) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: directory changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: owner ${opened.uid} does not match runtime uid ${uid}`);
    }
    if (created) fchmodSync(fd, 0o700);
    if ((fstatSync(fd).mode & 0o777) !== 0o700) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: directory mode must be 0700`);
    }
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: symlinks and non-directories are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Profile ancestors contain private descendants but may predate this preview
 * with ordinary 0755 permissions. They must still be canonical, current-uid,
 * owner-writable directories. A non-root uid=gid user-private-group layout
 * may use umask-0002 group write; world write and every other group-write
 * layout are refused. Newly-created ancestors are tightened to 0700.
 */
function assertSecureProfileAncestor(path: string, label: string, created = false): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`OpenCode profile refuses ${label} at ${path}: expected a canonical real directory`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isDirectory() || current.isSymbolicLink() || !sameIdentity(before, opened)
      || !sameIdentity(opened, current) || realpathSync(path) !== path) {
      throw new Error(`OpenCode profile refuses ${label} at ${path}: directory changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode profile refuses ${label} at ${path}: owner ${opened.uid} does not match runtime uid ${uid}`);
    }
    if (created) fchmodSync(fd, 0o700);
    const finalStat = fstatSync(fd);
    const mode = finalStat.mode & 0o777;
    if ((mode & 0o700) !== 0o700 || !opencodeOwnedPathModeIsSafe(finalStat)) {
      throw new Error(`OpenCode profile refuses ${label} at ${path}: owner must have rwx; world write and non-private group write are forbidden`);
    }
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`OpenCode profile refuses ${label} at ${path}: symlinks and non-directories are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureSecureProfileAncestor(parent: string, name: string, label: string): string {
  assertSecureProfileAncestor(parent, `${label} parent`);
  const path = join(parent, name);
  let created = false;
  if (!lstatIfPresent(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  assertSecureProfileAncestor(path, label, created);
  assertSecureProfileAncestor(parent, `${label} parent`);
  return path;
}

function ensurePrivateChildDirectory(root: string, parent: string, name: string, label: string): string {
  const path = join(parent, name);
  assertContained(root, path, label);
  assertPrivateDirectory(parent, `${label} parent`);
  let created = false;
  if (!lstatIfPresent(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  assertPrivateDirectory(path, label, created);
  assertPrivateDirectory(parent, `${label} parent`);
  assertContained(root, realpathSync(path), label);
  return path;
}

function assertPrivateRegularFile(path: string, label: string): ReturnType<typeof lstatSync> | undefined {
  const before = lstatIfPresent(path);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error(`OpenCode preset refuses ${label} at ${path}: expected a canonical single-link regular file`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)
      || !sameIdentity(opened, current)) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: file changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: owner ${opened.uid} does not match runtime uid ${uid}`);
    }
    if ((opened.mode & 0o777) !== 0o600) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: file mode must be 0600`);
    }
    return opened;
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: symlinks are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateRegularFile(path: string, label: string): string | undefined {
  if (!assertPrivateRegularFile(path, label)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || (uid !== undefined && opened.uid !== uid)
      || (opened.mode & 0o777) !== 0o600) {
      throw new Error(`OpenCode preset refuses ${label} at ${path}: file changed before read`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

interface PreparedPresetState {
  authPath: string;
  configPath: string;
}

export type OpencodePrivateProfileFilename = "config.json" | ".env";

/**
 * Establish the boundary before saveProfile/rewritePlainSecrets writes the
 * node token or dotenv key. The expected shape is exactly
 * `<project>/.anet/nodes/<node>`. Every existing path is inspected with
 * lstat + O_NOFOLLOW and inode checks; absent private directories are created
 * one component at a time. A pre-planted node-root/config/.env symlink is a
 * hard error before any secret-bearing write.
 */
export function prepareOpencodeNodeForProfileWrite(nodeWorkDir: string): string {
  if (nodeWorkDir.includes("\0")) throw new Error("OpenCode profile workDir contains a NUL byte");
  const workDir = resolve(nodeWorkDir);
  const nodesRoot = dirname(workDir);
  const anetRoot = dirname(nodesRoot);
  const projectRoot = dirname(anetRoot);
  if (basename(nodesRoot) !== "nodes" || basename(anetRoot) !== ".anet") {
    throw new Error("OpenCode profile workDir must be <project>/.anet/nodes/<node>");
  }

  assertSecureProfileAncestor(projectRoot, "project root");
  const preparedAnet = ensureSecureProfileAncestor(projectRoot, ".anet", ".anet root");
  if (preparedAnet !== anetRoot) throw new Error("OpenCode profile .anet path is not canonical");
  const preparedNodes = ensureSecureProfileAncestor(anetRoot, "nodes", "nodes root");
  if (preparedNodes !== nodesRoot) throw new Error("OpenCode profile nodes path is not canonical");

  let created = false;
  if (!lstatIfPresent(workDir)) {
    try {
      mkdirSync(workDir, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  assertPrivateDirectory(workDir, "node workDir", created);
  assertSecureProfileAncestor(nodesRoot, "nodes root");
  assertContained(nodesRoot, workDir, "node workDir");

  for (const filename of ["config.json", ".env"] as const) {
    assertPrivateRegularFile(join(workDir, filename), `node ${filename}`);
  }
  // Create and validate the whole OpenCode tree now. This ensures a missing-
  // key manual `opencode auth login` inherits private roots instead of asking
  // upstream 1.18.1 to create them as 0755.
  preparePresetState(workDir);
  return workDir;
}

export function readOpencodePrivateProfileFile(
  nodeWorkDir: string,
  filename: OpencodePrivateProfileFilename,
): string | undefined {
  const workDir = prepareOpencodeNodeForProfileWrite(nodeWorkDir);
  return readPrivateRegularFile(join(workDir, filename), `node ${filename}`);
}

export function writeOpencodePrivateProfileFile(
  nodeWorkDir: string,
  filename: OpencodePrivateProfileFilename,
  body: string,
): string {
  const workDir = prepareOpencodeNodeForProfileWrite(nodeWorkDir);
  const path = join(workDir, filename);
  atomicWritePrivateFile(path, body, `node ${filename}`);
  return path;
}

/** Validate the complete credential/config tree before either writer mutates it. */
function preparePresetState(nodeWorkDir: string): PreparedPresetState {
  if (nodeWorkDir.includes("\0")) throw new Error("OpenCode preset workDir contains a NUL byte");
  const workDir = resolve(nodeWorkDir);
  assertPrivateDirectory(workDir, "node workDir");

  const config = ensurePrivateChildDirectory(workDir, workDir, ".config", "config root");
  const configOpencode = ensurePrivateChildDirectory(workDir, config, "opencode", "OpenCode config directory");
  const local = ensurePrivateChildDirectory(workDir, workDir, ".local", "local state root");
  const data = ensurePrivateChildDirectory(workDir, local, "share", "data root");
  const dataOpencode = ensurePrivateChildDirectory(workDir, data, "opencode", "OpenCode data directory");
  ensurePrivateChildDirectory(workDir, local, "state", "state root");
  ensurePrivateChildDirectory(workDir, workDir, ".cache", "cache root");
  ensurePrivateChildDirectory(workDir, workDir, ".runtime", "runtime root");
  ensurePrivateChildDirectory(workDir, workDir, ".tmp", "temporary root");
  const configPath = join(configOpencode, "opencode.json");
  const authPath = join(dataOpencode, "auth.json");
  // Validate both targets up front. In particular, config creation must fail
  // before any key-bearing auth write when either side of the tree is unsafe.
  assertPrivateRegularFile(configPath, "OpenCode config file");
  assertPrivateRegularFile(authPath, "OpenCode auth file");
  return { authPath, configPath };
}

/** Atomic, no-follow replacement through a 0600 temporary inode. */
function atomicWritePrivateFile(path: string, body: string, label: string): void {
  const parent = dirname(path);
  assertPrivateDirectory(parent, `${label} parent`);
  const before = assertPrivateRegularFile(path, label);
  const temp = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, body, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const tempStat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!tempStat.isFile() || tempStat.nlink !== 1 || (uid !== undefined && tempStat.uid !== uid)) {
      throw new Error(`OpenCode preset refuses ${label}: temporary file is not owner-controlled`);
    }
    closeSync(fd);
    fd = undefined;

    assertPrivateDirectory(parent, `${label} parent`);
    const current = assertPrivateRegularFile(path, label);
    if ((before === undefined) !== (current === undefined)
      || (before !== undefined && current !== undefined && !sameIdentity(before, current))) {
      throw new Error(`OpenCode preset refuses ${label}: target changed before atomic rename`);
    }
    renameSync(temp, path);
    assertPrivateRegularFile(path, label);

    // Durably bind the rename to the already-validated private directory.
    const parentFd = openSync(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Write auth.json into the opencode config root that lives under
 * `nodeWorkDir` (the per-node OpenCode data root). mode 0o600 limits
 * filesystem access to the owning OS account; it does not prevent a
 * same-uid OpenCode child from opening the file directly. Directory is
 * created if missing.
 *
 * Returns the absolute path we wrote for logging.
 */
export function writeOpencodeAuthJson(
  nodeWorkDir: string,
  preset: OpencodePreset,
  apiKey: string,
): string {
  const { authPath } = preparePresetState(nodeWorkDir);
  const body = buildAuthJsonBody(preset, apiKey);
  atomicWritePrivateFile(authPath, body, "OpenCode auth file");
  return authPath;
}

/**
 * New keyless nodes must not inherit a private-but-preplanted credential.
 * Keep the file present as an explicit empty object so the creation log's
 * "auth not configured" statement matches the state OpenCode will consume.
 */
export function clearOpencodeAuthJson(nodeWorkDir: string): string {
  const { authPath } = preparePresetState(nodeWorkDir);
  atomicWritePrivateFile(authPath, "{}\n", "OpenCode auth file");
  return authPath;
}

/**
 * Companion opencode.json: records only the selected blessed provider
 * identity and safe-by-default tool policy. Pre-existing model routing and
 * arbitrary OpenCode integrations are stripped; operators may explicitly set
 * a model after creation, which the runtime's separate safe renderer retains.
 */
export function writeOpencodeConfigJson(
  nodeWorkDir: string,
  preset: OpencodePreset,
): string {
  const { configPath } = preparePresetState(nodeWorkDir);
  const body = JSON.stringify({
    // The persistent file is an input to a safe runtime renderer, not an
    // arbitrary OpenCode config merge point. Write only the blessed provider
    // identity. Existing model routing, MCP servers,
    // plugins, instructions, commands, agents, custom npm providers, URLs,
    // headers, and executable options are deliberately removed.
    $schema: "https://opencode.ai/config.json",
    provider: {
      [preset.configProviderId]: {
        options: {},
      },
    },
    tools: buildOpencodeDefaultToolsPolicy(),
    permission: buildOpencodeDefaultPermissionPolicy(),
    plugin: [],
    mcp: {},
  }, null, 2) + "\n";
  atomicWritePrivateFile(configPath, body, "OpenCode config file");
  return configPath;
}
