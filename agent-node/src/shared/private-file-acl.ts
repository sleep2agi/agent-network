import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, statSync } from "node:fs";
import { win32 } from "node:path";

/** Built-in Windows SIDs permitted alongside the current user on private files. */
export const WINDOWS_SYSTEM_SID = "S-1-5-18";
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";

const SID_RE = /^S-1-[0-9-]+$/;
const NTFS_LIKE_FS_RE = /^(?:NTFS|ReFS)$/i;
const ACL_COMMAND_TIMEOUT_MS = 10_000;

const WELL_KNOWN_SID_LABELS: Readonly<Record<string, string>> = {
  "S-1-1-0": "Everyone",
  "S-1-5-7": "Anonymous Logon",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-32-545": "BUILTIN\\Users",
  "S-1-5-32-546": "BUILTIN\\Guests",
};

const READ_WINDOWS_ACL_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$p = $env:ANET_ACL_TARGET",
  "$item = Get-Item -LiteralPath $p -Force",
  "$acl = Get-Acl -LiteralPath $p",
  "$curSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
  "$driveFs = try { [IO.DriveInfo]::new([IO.Path]::GetPathRoot($item.FullName)).DriveFormat } catch { '' }",
  "$aces = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {",
  "  [ordered]@{",
  "    sid = $_.IdentityReference.Value",
  "    type = $_.AccessControlType.ToString()",
  "    rights = $_.FileSystemRights.ToString()",
  "    inherited = [bool]$_.IsInherited",
  "  }",
  "})",
  "[ordered]@{",
  "  currentUserSid = $curSid",
  "  ownerSid = $ownerSid",
  "  isReparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)",
  "  isDirectory = [bool]$item.PSIsContainer",
  "  protected = [bool]$acl.AreAccessRulesProtected",
  "  driveFormat = $driveFs",
  "  access = $aces",
  "} | ConvertTo-Json -Depth 4 -Compress",
].join("\n");

const READ_WINDOWS_SID_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
].join("\n");

export interface WindowsAclAce {
  sid: string;
  type: string;
  rights: string;
  inherited: boolean;
}

export interface WindowsAclSnapshot {
  currentUserSid: string;
  ownerSid: string;
  isReparsePoint: boolean;
  isDirectory: boolean;
  protected: boolean;
  driveFormat: string;
  access: WindowsAclAce[];
}

export type ParseWindowsAclResult =
  | { ok: true; snapshot: WindowsAclSnapshot }
  | { ok: false; reason: string };

export type PrivateFileCheckCode =
  | "not_regular_file"
  | "posix_mode_too_open"
  | "windows_acl_unreadable"
  | "windows_acl_parse_error"
  | "windows_non_ntfs"
  | "windows_reparse_point"
  | "windows_owner_untrusted"
  | "windows_acl_empty"
  | "windows_acl_too_open";

export type PrivateFileCheckFailure = {
  ok: false;
  code: PrivateFileCheckCode;
  /** Human-readable diagnosis. Never contains file contents or executed command lines. */
  reason: string;
  /** Copy-pasteable remediation command for the operator. */
  fixCommand: string;
  offendingSids?: string[];
  inheritedExposure?: boolean;
};

export type PrivateFileCheckResult = { ok: true } | PrivateFileCheckFailure;

export interface CheckPrivateFileDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  stat?: typeof statSync;
  lstat?: typeof lstatSync;
  readWindowsAclRaw?: (filePath: string) => string;
}

export interface AssertPrivateFileOptions {
  /** Stable machine-readable prefix kept intact for callers/tests. */
  errorPrefix: string;
  /** Human-readable description of the protected file. */
  label?: string;
  deps?: CheckPrivateFileDeps;
}

export interface TightenPrivateFileDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  chmod?: typeof chmodSync;
  lstat?: typeof lstatSync;
  readCurrentWindowsSid?: () => string;
  runIcacls?: (args: string[]) => void;
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function resolveWindowsSystemTool(
  relParts: readonly string[],
  fallbackName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.SystemRoot ?? env.windir;
  if (root && win32.isAbsolute(root)) {
    return win32.join(root, ...relParts);
  }
  return fallbackName;
}

function describeSid(sid: string): string {
  const label = WELL_KNOWN_SID_LABELS[sid];
  return label ? `${label} (${sid})` : sid;
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Format an actionable, copy-pasteable fix command for tightening a private file. */
export function formatPrivateFileFixCommand(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const quoted = quotePowerShellSingle(filePath);
    return (
      `$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `
      + `icacls.exe ${quoted} /inheritance:r /grant:r "*$($sid):F" "*${WINDOWS_SYSTEM_SID}:F" "*${WINDOWS_ADMINISTRATORS_SID}:F"`
    );
  }
  return `chmod 600 ${quotePosixSingle(filePath)}`;
}

/** Pure argv builder for `icacls.exe` tightening (unit-testable on Linux). */
export function buildWindowsTightenArgs(filePath: string, currentUserSid: string): string[] {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("private file path is invalid");
  }
  if (!SID_RE.test(currentUserSid)) {
    throw new Error("current Windows user SID is invalid");
  }
  return [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `*${currentUserSid}:F`,
    `*${WINDOWS_SYSTEM_SID}:F`,
    `*${WINDOWS_ADMINISTRATORS_SID}:F`,
  ];
}

/**
 * Pure parser for the JSON emitted by our PowerShell `Get-Acl` probe.
 * Accepts real Windows PowerShell 5.1 / PowerShell 7 output verbatim, including
 * optional UTF-8 BOM or single-object `access` serialization.
 */
export function parseWindowsAclOutput(rawOutput: string): ParseWindowsAclResult {
  const cleaned = rawOutput.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    return { ok: false, reason: "empty Windows ACL output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: "invalid JSON in Windows ACL output" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Windows ACL output must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.currentUserSid !== "string" || !SID_RE.test(obj.currentUserSid)) {
    return { ok: false, reason: "Windows ACL output missing valid currentUserSid" };
  }
  if (typeof obj.ownerSid !== "string" || !SID_RE.test(obj.ownerSid)) {
    return { ok: false, reason: "Windows ACL output missing valid ownerSid" };
  }
  if (
    typeof obj.isReparsePoint !== "boolean"
    || typeof obj.isDirectory !== "boolean"
    || typeof obj.protected !== "boolean"
    || typeof obj.driveFormat !== "string"
  ) {
    return { ok: false, reason: "Windows ACL output missing required metadata fields" };
  }
  const rawAccess = obj.access === null || obj.access === undefined
    ? []
    : Array.isArray(obj.access)
      ? obj.access
      : [obj.access];
  const access: WindowsAclAce[] = [];
  for (const entry of rawAccess) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "Windows ACL output contains a malformed ACE entry" };
    }
    const ace = entry as Record<string, unknown>;
    if (
      typeof ace.sid !== "string"
      || !SID_RE.test(ace.sid)
      || typeof ace.type !== "string"
      || typeof ace.rights !== "string"
      || typeof ace.inherited !== "boolean"
    ) {
      return { ok: false, reason: "Windows ACL output contains an invalid ACE field" };
    }
    access.push({
      sid: ace.sid,
      type: ace.type,
      rights: ace.rights,
      inherited: ace.inherited,
    });
  }
  return {
    ok: true,
    snapshot: {
      currentUserSid: obj.currentUserSid,
      ownerSid: obj.ownerSid,
      isReparsePoint: obj.isReparsePoint,
      isDirectory: obj.isDirectory,
      protected: obj.protected,
      driveFormat: obj.driveFormat,
      access,
    },
  };
}

/**
 * Pure policy check: allow access ONLY to current user, NT AUTHORITY\SYSTEM,
 * and BUILTIN\Administrators on a local NTFS/ReFS non-reparse regular file.
 */
export function evaluateWindowsPrivateFileAcl(
  snapshot: WindowsAclSnapshot,
  filePath: string,
): PrivateFileCheckResult {
  const fixCommand = formatPrivateFileFixCommand(filePath, "win32");
  if (snapshot.isReparsePoint) {
    return {
      ok: false,
      code: "windows_reparse_point",
      reason: "文件是符号链接或重解析点（ReparsePoint），拒绝作为私密文件读取",
      fixCommand,
    };
  }
  if (snapshot.isDirectory) {
    return {
      ok: false,
      code: "not_regular_file",
      reason: "路径指向目录而非普通文件",
      fixCommand,
    };
  }
  if (!NTFS_LIKE_FS_RE.test(snapshot.driveFormat.trim())) {
    const fsLabel = snapshot.driveFormat.trim() || "unknown";
    return {
      ok: false,
      code: "windows_non_ntfs",
      reason: `文件所在卷（${fsLabel}）不支持 NTFS ACL 保护，请移至本地 NTFS 磁盘（例如 %USERPROFILE%\\.anet\\）后收紧权限`,
      fixCommand,
    };
  }
  const trustedSids = new Set<string>([
    snapshot.currentUserSid,
    WINDOWS_SYSTEM_SID,
    WINDOWS_ADMINISTRATORS_SID,
  ]);
  if (!trustedSids.has(snapshot.ownerSid)) {
    return {
      ok: false,
      code: "windows_owner_untrusted",
      reason: `文件属主（${describeSid(snapshot.ownerSid)}）不是当前用户、SYSTEM 或 Administrators`,
      fixCommand,
    };
  }
  const allowAces = snapshot.access.filter((ace) => ace.type.toLowerCase() === "allow");
  if (allowAces.length === 0) {
    return {
      ok: false,
      code: "windows_acl_empty",
      reason: "未能确认有效的 NTFS 访问控制项（DACL 为空），按安全默认拒绝",
      fixCommand,
    };
  }
  const offendingAces = allowAces.filter((ace) => !trustedSids.has(ace.sid));
  if (offendingAces.length > 0) {
    const offendingSids = Array.from(new Set(offendingAces.map((ace) => ace.sid)));
    const inheritedExposure = offendingAces.some((ace) => ace.inherited);
    const sidSummary = offendingSids.map(describeSid).join(", ");
    const sourceHint = inheritedExposure ? "（包含从父目录继承的宽松权限）" : "";
    return {
      ok: false,
      code: "windows_acl_too_open",
      reason: `NTFS 权限过宽${sourceHint}：允许除当前用户 / SYSTEM / Administrators 以外的主体访问（${sidSummary}）`,
      fixCommand,
      offendingSids,
      inheritedExposure,
    };
  }
  return { ok: true };
}

function safeExecFailureSummary(error: unknown): string {
  const err = error as { code?: unknown; status?: unknown } | null;
  if (typeof err?.code === "string" && err.code) return err.code;
  if (typeof err?.status === "number") return `exit ${err.status}`;
  return "command failed";
}

function defaultReadWindowsAclRaw(filePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const psBin = resolveWindowsSystemTool(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    "powershell.exe",
    env,
  );
  return execFileSync(
    psBin,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(READ_WINDOWS_ACL_PS_SCRIPT)],
    {
      encoding: "utf8",
      env: { ...env, ANET_ACL_TARGET: filePath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: ACL_COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    },
  );
}

function defaultReadCurrentWindowsSid(env: NodeJS.ProcessEnv = process.env): string {
  const psBin = resolveWindowsSystemTool(
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    "powershell.exe",
    env,
  );
  return execFileSync(
    psBin,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(READ_WINDOWS_SID_PS_SCRIPT)],
    {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: ACL_COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    },
  ).replace(/^\uFEFF/, "").trim();
}

function defaultRunIcacls(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const icaclsBin = resolveWindowsSystemTool(["System32", "icacls.exe"], "icacls.exe", env);
  execFileSync(icaclsBin, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: ACL_COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
}

/**
 * Check whether `filePath` is a private regular file:
 * - Linux/macOS: existing POSIX permission bit check (`(stat.mode & 0o077) === 0`).
 * - Windows: regular non-symlink single-link file on NTFS/ReFS whose owner and
 *   all Allow ACEs (explicit + inherited) are limited to current user, SYSTEM,
 *   and Administrators.
 */
export function checkPrivateFile(
  filePath: string,
  deps: CheckPrivateFileDeps = {},
): PrivateFileCheckResult {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const statFn = deps.stat ?? statSync;
  const lstatFn = deps.lstat ?? lstatSync;

  if (platform !== "win32") {
    const st = statFn(filePath);
    const fixCommand = formatPrivateFileFixCommand(filePath, platform);
    if (!st.isFile()) {
      return {
        ok: false,
        code: "not_regular_file",
        reason: "路径不是普通文件",
        fixCommand,
      };
    }
    if ((st.mode & 0o077) !== 0) {
      const modeOctal = (st.mode & 0o777).toString(8).padStart(3, "0");
      return {
        ok: false,
        code: "posix_mode_too_open",
        reason: `文件权限为 ${modeOctal}，组或其他用户可访问，要求仅当前用户可读写（0600）`,
        fixCommand,
      };
    }
    return { ok: true };
  }

  const fixCommand = formatPrivateFileFixCommand(filePath, "win32");
  const lst = lstatFn(filePath);
  if (lst.isSymbolicLink()) {
    return {
      ok: false,
      code: "windows_reparse_point",
      reason: "文件是符号链接，拒绝作为私密文件读取",
      fixCommand,
    };
  }
  if (!lst.isFile() || lst.nlink !== 1) {
    return {
      ok: false,
      code: "not_regular_file",
      reason: "路径不是单链接普通文件",
      fixCommand,
    };
  }

  let rawOutput: string;
  try {
    rawOutput = deps.readWindowsAclRaw
      ? deps.readWindowsAclRaw(filePath)
      : defaultReadWindowsAclRaw(filePath, env);
  } catch (error) {
    return {
      ok: false,
      code: "windows_acl_unreadable",
      reason: `无法读取文件 Windows ACL（${safeExecFailureSummary(error)}），按安全默认拒绝`,
      fixCommand,
    };
  }
  const parsed = parseWindowsAclOutput(rawOutput);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "windows_acl_parse_error",
      reason: `无法解析文件 Windows ACL（${parsed.reason}），按安全默认拒绝`,
      fixCommand,
    };
  }
  return evaluateWindowsPrivateFileAcl(parsed.snapshot, filePath);
}

/**
 * Format a concise, human-readable error message with remediation command.
 * Never includes file contents or executed command lines.
 */
export function formatPrivateFileError(
  failure: PrivateFileCheckFailure,
  opts: { errorPrefix: string; label?: string; filePath: string },
): string {
  const subject = opts.label ? `${opts.label} (${opts.filePath})` : opts.filePath;
  return `${opts.errorPrefix}: ${subject} ${failure.reason}。修复命令: ${failure.fixCommand}`;
}

/** Assert that `filePath` passes private-file checks, or throw an actionable Error. */
export function assertPrivateFile(filePath: string, opts: AssertPrivateFileOptions): void {
  const result = checkPrivateFile(filePath, opts.deps);
  if (!result.ok) {
    throw new Error(formatPrivateFileError(result, {
      errorPrefix: opts.errorPrefix,
      label: opts.label,
      filePath,
    }));
  }
}

/**
 * Tighten `filePath` so only the current user (plus SYSTEM / Administrators on
 * Windows) can access it.
 */
export function tightenPrivateFile(
  filePath: string,
  deps: TightenPrivateFileDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const chmodFn = deps.chmod ?? chmodSync;
  const lstatFn = deps.lstat ?? lstatSync;

  if (platform !== "win32") {
    chmodFn(filePath, 0o600);
    return;
  }

  const lst = lstatFn(filePath);
  if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink !== 1) {
    throw new Error(`refusing to tighten Windows ACL on non-regular or linked file: ${filePath}`);
  }
  let sid: string;
  try {
    sid = deps.readCurrentWindowsSid
      ? deps.readCurrentWindowsSid()
      : defaultReadCurrentWindowsSid(env);
  } catch (error) {
    throw new Error(`failed to resolve current Windows user SID (${safeExecFailureSummary(error)})`);
  }
  const args = buildWindowsTightenArgs(filePath, sid);
  try {
    if (deps.runIcacls) deps.runIcacls(args);
    else defaultRunIcacls(args, env);
  } catch (error) {
    throw new Error(`failed to tighten Windows ACL on ${filePath} (${safeExecFailureSummary(error)})`);
  }
}
