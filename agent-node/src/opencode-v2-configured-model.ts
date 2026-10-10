// OpenCode V2 co-presence create reads the model and provider OpenCode
// already has on this machine. The documents are OpenCode's own
// opencode.json / opencode.jsonc: string `model` (`provider/model`) and
// optional `providers` (plural). This module does not define a second
// provider schema and does not substitute a default model.
//
// Discovery follows OpenCode's published order: global config, then
// direct project files from the filesystem root down to the project,
// then `.opencode` files in that same far-to-near order (every
// `.opencode` file overrides every direct file). A later `model` string
// replaces an earlier one. A later `providers.<id>` object replaces that
// id's whole entry. Other provider ids are kept.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isReservedEnvKey } from "./shared/reserved-env.js";

const MODEL_SEGMENT = "[a-zA-Z0-9._:\\-]+";
const MODEL_EXACT = new RegExp(`^${MODEL_SEGMENT}/${MODEL_SEGMENT}$`);
const DOT_ONLY = /(^|\/)\.+(\/|$)/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_REF = /^\{env:[A-Z][A-Z0-9_]*\}$/;
const SECRET_KEY = /^(api[_-]?key|token|secret|password|authorization)$/i;
const BLOCKED_ENV_PREFIXES = ["ANET_", "COMMHUB_", "OPENCODE_"] as const;
const MAX_BYTES = 256 * 1024;

export type OpenCodeV2AlignCode =
  | "opencode_v2_configured_model_missing"
  | "opencode_v2_model_mismatch"
  | "opencode_v2_provider_mismatch"
  | "opencode_v2_config_unreadable"
  | "opencode_v2_provider_credential_missing";

export class OpenCodeV2AlignError extends Error {
  readonly code: OpenCodeV2AlignCode;
  constructor(code: OpenCodeV2AlignCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "OpenCodeV2AlignError";
    this.code = code;
  }
}

export interface OpenCodeConfiguredSelection {
  readonly model: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Native `providers[providerId]` object, when the merged config has one. */
  readonly providerEntry?: Readonly<Record<string, unknown>>;
  readonly credentialEnv: readonly string[];
}

export interface OpenCodeConfigLayer {
  readonly label: string;
  readonly document: Readonly<Record<string, unknown>>;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Drop JSONC comments and trailing commas without touching string contents. */
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const c = input[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < input.length) out += input[i + 1];
        i += 2;
        continue;
      }
      if (c === "\"") inString = false;
      i++;
      continue;
    }
    if (c === "\"") {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i = Math.min(input.length, i + 2);
      continue;
    }
    if (c === ",") {
      let k = i + 1;
      while (k < input.length) {
        if (input[k] === "/" && input[k + 1] === "/") {
          k += 2;
          while (k < input.length && input[k] !== "\n") k++;
          continue;
        }
        if (input[k] === "/" && input[k + 1] === "*") {
          k += 2;
          while (k + 1 < input.length && !(input[k] === "*" && input[k + 1] === "/")) k++;
          k = Math.min(input.length, k + 2);
          continue;
        }
        if (/\s/.test(input[k]!)) {
          k++;
          continue;
        }
        break;
      }
      if (input[k] === "}" || input[k] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function parseConfigText(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} is not JSON. OpenCode's opencode.json(c) must parse before a V2 node is created.`,
    );
  }
  if (!isPlain(parsed)) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} must be a JSON object.`,
    );
  }
  return parsed;
}

function assertNoInlineSecret(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecret(item, `${path}[${index}]`));
    return;
  }
  if (!isPlain(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof child === "string" && !ENV_REF.test(child)) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_config_unreadable",
        `OpenCode provider field ${path}.${key} holds a raw credential. Native providers name environment variables in env; the value is not copied.`,
      );
    }
    assertNoInlineSecret(child, `${path}.${key}`);
  }
}

function credentialNames(entry: Record<string, unknown>, providerId: string): string[] {
  if (entry.env === undefined) return [];
  if (!Array.isArray(entry.env) || entry.env.length === 0) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `OpenCode provider ${providerId} env must be a non-empty array of variable names.`,
    );
  }
  const names: string[] = [];
  for (const name of entry.env) {
    if (typeof name !== "string" || !ENV_NAME.test(name)
      || isReservedEnvKey(name)
      || BLOCKED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_config_unreadable",
        `OpenCode provider ${providerId} has an env name that cannot be forwarded.`,
      );
    }
    names.push(name);
  }
  return names;
}

function splitModel(model: string, label: string): { providerId: string; modelId: string } {
  if (model.includes("#") || /\s/.test(model) || !MODEL_EXACT.test(model) || DOT_ONLY.test(model)) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} model must be OpenCode's provider/model string (exactly one slash, no variant).`,
    );
  }
  const slash = model.indexOf("/");
  const providerId = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (!PROVIDER_ID.test(providerId)) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} provider id is not an OpenCode provider id.`,
    );
  }
  return { providerId, modelId };
}

/** Merge already-loaded layers. Exported so tests can pin precedence
 * without depending on the machine's real OpenCode config. */
export function mergeOpenCodeConfigLayers(layers: readonly OpenCodeConfigLayer[]): OpenCodeConfiguredSelection {
  let model: string | undefined;
  const providers: Record<string, unknown> = {};
  let sawProvider = false;
  for (const layer of layers) {
    if (Object.prototype.hasOwnProperty.call(layer.document, "model")) {
      const value = layer.document.model;
      if (typeof value !== "string" || !value.trim()) {
        throw new OpenCodeV2AlignError(
          "opencode_v2_config_unreadable",
          `${layer.label} sets model to a value that is not a provider/model string. The previous model is not kept.`,
        );
      }
      model = value.trim();
      splitModel(model, layer.label);
    }
    if (layer.document.providers !== undefined) {
      if (!isPlain(layer.document.providers)) {
        throw new OpenCodeV2AlignError(
          "opencode_v2_config_unreadable",
          `${layer.label} providers must be an object.`,
        );
      }
      sawProvider = true;
      for (const [id, entry] of Object.entries(layer.document.providers)) {
        if (!PROVIDER_ID.test(id) || !isPlain(entry)) {
          throw new OpenCodeV2AlignError(
            "opencode_v2_config_unreadable",
            `${layer.label} has a providers entry that is not an OpenCode provider object.`,
          );
        }
        providers[id] = entry;
      }
    }
  }
  if (!model) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_configured_model_missing",
      "OpenCode on this machine has no model in its config. Set model to provider/model in OpenCode's opencode.json before creating a V2 co-presence node. This create does not fall back to another provider.",
    );
  }
  const { providerId, modelId } = splitModel(model, "OpenCode");
  let providerEntry: Record<string, unknown> | undefined;
  let credentialEnv: string[] = [];
  if (sawProvider && Object.prototype.hasOwnProperty.call(providers, providerId)) {
    const entry = providers[providerId];
    if (!isPlain(entry)) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_config_unreadable",
        `OpenCode provider ${providerId} must be an object.`,
      );
    }
    assertNoInlineSecret(entry, providerId);
    providerEntry = structuredClone(entry);
    credentialEnv = credentialNames(providerEntry, providerId);
  }
  return {
    model,
    providerId,
    modelId,
    ...(providerEntry ? { providerEntry } : {}),
    credentialEnv,
  };
}

export function renderOpenCodeV2AlignedConfig(selection: OpenCodeConfiguredSelection): string {
  const doc: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model: selection.model,
  };
  if (selection.providerEntry) {
    doc.providers = { [selection.providerId]: selection.providerEntry };
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function assertOpenCodeV2RequestedModel(
  selection: OpenCodeConfiguredSelection,
  requestedModel: string | undefined,
): void {
  if (requestedModel === undefined) return;
  if (requestedModel !== selection.model) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_model_mismatch",
      `requested ${JSON.stringify(requestedModel)} does not match this machine's OpenCode model ${JSON.stringify(selection.model)}. Create does not switch or fall back.`,
    );
  }
}

function directoryChain(start: string): string[] {
  const farToNear: string[] = [];
  let current = resolve(start);
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) break;
    seen.add(current);
    farToNear.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return farToNear.reverse();
}

function readPrivateText(path: string, label: string): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
    );
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} must be a regular file, not a symlink.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} is not owned by this user.`,
    );
  }
  if ((st.mode & 0o022) !== 0) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} is group- or world-writable.`,
    );
  }
  if (st.size > MAX_BYTES) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} is larger than ${MAX_BYTES} bytes.`,
    );
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) {
      throw new OpenCodeV2AlignError(
        "opencode_v2_config_unreadable",
        `${label} changed before it was read.`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function loadSlot(dir: string, label: string): OpenCodeConfigLayer | undefined {
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  const json = readPrivateText(jsonPath, `${label} opencode.json`);
  const jsonc = readPrivateText(jsoncPath, `${label} opencode.jsonc`);
  if (json !== undefined && jsonc !== undefined) {
    throw new OpenCodeV2AlignError(
      "opencode_v2_config_unreadable",
      `${label} has both opencode.json and opencode.jsonc. Refusing to pick one.`,
    );
  }
  const text = json ?? jsonc;
  if (text === undefined) return undefined;
  return { label, document: parseConfigText(text, label) };
}

export function readOpenCodeConfiguredSelection(input: {
  projectDir: string;
  homeDir: string;
  xdgConfigHome?: string;
}): OpenCodeConfiguredSelection {
  const globalDir = input.xdgConfigHome
    ? join(input.xdgConfigHome, "opencode")
    : join(input.homeDir, ".config", "opencode");
  const layers: OpenCodeConfigLayer[] = [];
  const globalLayer = loadSlot(globalDir, "global OpenCode config");
  if (globalLayer) layers.push(globalLayer);
  const chain = directoryChain(input.projectDir);
  for (const dir of chain) {
    const layer = loadSlot(dir, `project ${basename(dir) || "/"}`);
    if (layer) layers.push(layer);
  }
  for (const dir of chain) {
    const layer = loadSlot(join(dir, ".opencode"), `.opencode ${basename(dir) || "/"}`);
    if (layer) layers.push(layer);
  }
  return mergeOpenCodeConfigLayers(layers);
}
