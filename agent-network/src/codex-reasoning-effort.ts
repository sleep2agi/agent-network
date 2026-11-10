import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Codex `config.toml` + `-c` override for thinking / reasoning effort.
 * Wire name matches app-server JSON (`reasoningEffort`) and client patch field. */

export const CODEX_MODEL_REASONING_EFFORT_KEY = "model_reasoning_effort";

/** Matches agent-node `types/codex/ReasoningEffort.ts` and models_cache gate. */
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number];

export function isReasoningEffortValue(v: unknown): v is ReasoningEffortValue {
  return typeof v === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(v);
}

export function reasoningEffortValidationReason(): string {
  return `must be one of ${REASONING_EFFORT_VALUES.join("/")}`;
}

/** `-c` fragment value (no shell quoting). */
export function codexReasoningEffortConfigOverride(effort: ReasoningEffortValue): string {
  return `${CODEX_MODEL_REASONING_EFFORT_KEY}=${effort}`;
}

/**
 * Idempotent merge of top-level `model_reasoning_effort` in codex config.toml.
 * Other tables and keys are preserved byte-for-byte except the managed line.
 */
export function mergeModelReasoningEffortIntoToml(existing: string, effort: ReasoningEffortValue): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = existing.endsWith("\n") ? existing.slice(0, -1) : existing;
  const lines = trimmed.length ? trimmed.split(/\r?\n/) : [];
  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const keyRe = new RegExp(`^\\s*${CODEX_MODEL_REASONING_EFFORT_KEY}\\s*=`);
  const newLine = `${CODEX_MODEL_REASONING_EFFORT_KEY} = ${JSON.stringify(effort)}`;
  let inSection = false;
  let replaced = false;
  const out: string[] = [];

  for (const line of lines) {
    const header = headerRe.exec(line);
    if (header) {
      inSection = true;
      out.push(line);
      continue;
    }
    if (!inSection && keyRe.test(line)) {
      out.push(newLine);
      replaced = true;
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.unshift(newLine);
  }
  const body = out.join(eol);
  return body.endsWith("\n") || body.length === 0 ? body + (body.length ? "" : eol) : body + eol;
}

/** Persist `model_reasoning_effort` under a node's `codex-home/`. */
export function writeReasoningEffortToCodexHome(codexHome: string, effort: ReasoningEffortValue): void {
  const path = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    if (existsSync(path)) existing = readFileSync(path, "utf8");
  } catch { /* first write */ }
  const next = mergeModelReasoningEffortIntoToml(existing, effort);
  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* win32 */ }
}
