// Default permission posture for Codex TUI co-presence nodes (#815 / Vincent 2026-10).
// Unattended Hub/Daemon children must not block on TUI yes/no prompts.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** API `flags.*` shape (client #815 / codexSdkYoloFlags). */
export const CODEX_COPRESENCE_YOLO_FLAGS: Readonly<{
  approvalPolicy: "never";
  sandboxMode: "danger-full-access";
  skipGitRepoCheck: true;
}> = {
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
  skipGitRepoCheck: true,
};

/** Top-level Codex `config.toml` keys for the same posture. */
export const CODEX_COPRESENCE_YOLO_TOML: Readonly<{
  approval_policy: "never";
  sandbox_mode: "danger-full-access";
}> = {
  approval_policy: "never",
  sandbox_mode: "danger-full-access",
};

/** Fill missing yolo flags when a co-presence codex-app-server node is created. */
export function applyCodexCopresenceFlagDefaults(flags: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(CODEX_COPRESENCE_YOLO_FLAGS)) {
    if (flags[k] === undefined) flags[k] = v;
  }
}

function mergeTopLevelTomlKeys(existing: string, entries: Record<string, string>): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const trimmed = existing.endsWith("\n") ? existing.slice(0, -1) : existing;
  const lines = trimmed.length ? trimmed.split(/\r?\n/) : [];
  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
  const pending = new Map(Object.entries(entries));
  let inSection = false;
  const out: string[] = [];

  for (const line of lines) {
    const header = headerRe.exec(line);
    if (header) {
      inSection = true;
      out.push(line);
      continue;
    }
    if (!inSection) {
      let replaced = false;
      for (const [key, value] of pending) {
        const keyRe = new RegExp(`^\\s*${key}\\s*=`);
        if (keyRe.test(line)) {
          out.push(`${key} = ${JSON.stringify(value)}`);
          pending.delete(key);
          replaced = true;
          break;
        }
      }
      if (!replaced) out.push(line);
      continue;
    }
    out.push(line);
  }
  const newLines = [...pending.entries()].map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  if (newLines.length) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.unshift(...newLines);
  }
  const body = out.join(eol);
  return body.endsWith("\n") || body.length === 0 ? body + (body.length ? "" : eol) : body + eol;
}

export function mergeCopresenceYoloIntoToml(existing: string): string {
  return mergeTopLevelTomlKeys(existing, { ...CODEX_COPRESENCE_YOLO_TOML });
}

/** Persist co-presence yolo posture under `<nodeDir>/codex-home/config.toml`. */
export function writeCopresenceYoloToCodexHome(codexHome: string): void {
  const path = join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  let existing = "";
  try {
    if (existsSync(path)) existing = readFileSync(path, "utf8");
  } catch { /* first write */ }
  const next = mergeCopresenceYoloIntoToml(existing);
  writeFileSync(path, next, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* win32 */ }
}
