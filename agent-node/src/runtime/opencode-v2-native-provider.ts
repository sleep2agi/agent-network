// Pass OpenCode V2's own `providers` document into the inline config V2
// actually reads (OPENCODE_CONFIG_CONTENT), and copy only the credential
// env vars that document names.
//
// This is not a second provider schema. A planted opencode.json cannot pull
// arbitrary parent environment: each `providers.*.env` name must also be a
// config.json env key, must not be reserved, and must not use the ANET_ /
// COMMHUB_ / OPENCODE_ prefixes. A missing value fails closed and the error
// does not include the value. Safe mode and the credential-free probe never
// call this.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isReservedEnvKey } from "../shared/reserved-env";
import { OPENCODE_V2_NATIVE_PACKAGES } from "./opencode-v2-native-packages";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BLOCKED_PREFIXES = ["ANET_", "COMMHUB_", "OPENCODE_"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPrivateConfig(path: string): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw new Error("OpenCode V2 provider config is not a regular private file");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error("OpenCode V2 provider config is not owned by this user");
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw new Error("OpenCode V2 provider config must be mode 0600");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) {
      throw new Error("OpenCode V2 provider config changed before it was read");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertBaseUrl(value: unknown): void {
  if (typeof value !== "string" || /[\s\u0000]/.test(value)) {
    throw new Error("OpenCode V2 provider settings.baseURL must be a single-line URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenCode V2 provider settings.baseURL is not a URL");
  }
  if (url.username || url.password) throw new Error("OpenCode V2 provider settings.baseURL must not contain credentials");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("OpenCode V2 provider settings.baseURL must be https, or http on loopback");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenCode V2 provider settings.baseURL scheme is not http(s)");
  }
}

function credentialNames(entry: Record<string, unknown>, providerId: string): string[] {
  if (entry.env === undefined) return [];
  if (!Array.isArray(entry.env) || entry.env.length === 0) {
    throw new Error(`OpenCode V2 provider ${providerId} env must be a non-empty array of variable names`);
  }
  const names: string[] = [];
  for (const name of entry.env) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      throw new Error(`OpenCode V2 provider ${providerId} has an invalid env name`);
    }
    if (isReservedEnvKey(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error(`OpenCode V2 provider ${providerId} env ${name} is reserved`);
    }
    names.push(name);
  }
  return names;
}

export interface WireOpenCodeV2NativeProvidersOptions {
  workDir: string;
  parentEnv: NodeJS.ProcessEnv;
  /** Keys present in the node config.json `env` object. */
  configEnvKeys: readonly string[];
}

/** Merge native `providers` into the V2 inline config and copy the named
 * credentials onto the child env. No-op when the node has no `providers`. */
export function wireOpenCodeV2NativeProviders(
  childEnv: NodeJS.ProcessEnv,
  opts: WireOpenCodeV2NativeProvidersOptions,
): void {
  const text = readPrivateConfig(join(opts.workDir, ".config", "opencode", "opencode.json"));
  if (text === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenCode V2 provider config is not JSON");
  }
  if (!isPlainRecord(parsed) || parsed.providers === undefined) return;
  if (!isPlainRecord(parsed.providers)) throw new Error("OpenCode V2 providers must be an object");

  const allowed = new Set(opts.configEnvKeys);
  for (const [providerId, raw] of Object.entries(parsed.providers)) {
    if (!PROVIDER_ID.test(providerId)) throw new Error("OpenCode V2 provider id is not a native id");
    if (!isPlainRecord(raw)) throw new Error(`OpenCode V2 provider ${providerId} must be an object`);
    if (raw.package !== undefined) {
      if (typeof raw.package !== "string" || !OPENCODE_V2_NATIVE_PACKAGES.includes(raw.package)) {
        throw new Error(
          `OpenCode V2 provider ${providerId} package is not a pinned native package. Catalog providers omit package; custom OpenAI-compatible providers use @opencode/ai/providers/openai-compatible.`,
        );
      }
    }
    if (raw.settings !== undefined) {
      if (!isPlainRecord(raw.settings)) throw new Error(`OpenCode V2 provider ${providerId} settings must be an object`);
      if (raw.settings.baseURL !== undefined) assertBaseUrl(raw.settings.baseURL);
    }
    for (const name of credentialNames(raw, providerId)) {
      if (!allowed.has(name)) {
        throw new Error(
          `OpenCode V2 provider ${providerId} references ${name}, which is not a config.json env key. Refusing to forward it.`,
        );
      }
      const value = opts.parentEnv[name];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `OpenCode V2 provider ${providerId} references ${name}, but that variable is not set for this process.`,
        );
      }
      childEnv[name] = value;
    }
  }

  const inline = JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? "{}");
  if (!isPlainRecord(inline)) throw new Error("OpenCode V2 inline config is not an object");
  const current = isPlainRecord(inline.providers) ? inline.providers : {};
  inline.providers = { ...current, ...parsed.providers };
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
}
