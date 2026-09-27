// `anet secret …` / `anet node secret …` — set, unset and list local secrets
// (the files and their load order are described in node-secrets.ts).
//
// 🔴 A value never comes from argv: it would land in shell history and in
//    `ps` output. It is read from the TTY with echo off, or from stdin when
//    piped. Output names keys, sources and lengths — never a value.

import { existsSync } from "node:fs";
import {
  daemonSecretsPath,
  listSecretEntries,
  nodeSecretsPath,
  readSecretsFile,
  secretKeyProblem,
  setSecret,
  unsetSecret,
  type SecretsFileRead,
} from "./node-secrets";

export interface SecretIO {
  stdinIsTTY: boolean;
  /** Read the value: TTY → prompt with echo off; otherwise all of stdin. */
  readValue: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface SecretContext {
  home: string;
  /** Node ref → its directory (the one holding config.json), or an error line. */
  resolveNode: (ref: string) => { dir: string; id: string; configEnvKeys: string[] } | { error: string };
  io: SecretIO;
}

export const SECRET_USAGE = [
  "Usage:",
  "  anet secret set <KEY>                     sets a daemon (this machine) env var shared by all nodes on this machine",
  "                                            (~/.anet/secrets.env)",
  "  anet secret unset <KEY>",
  "  anet secret list [--node <node>]          key names, layer, length — never values",
  "  anet node secret set <node> <KEY>         sets a node env var (<node dir>/secrets.env), overrides the daemon one",
  "  anet node secret unset <node> <KEY>",
  "  anet node secret list <node>",
  "",
  "The value is read from the terminal (not echoed) or from stdin:",
  "  printf '%s' \"$VALUE\" | anet secret set OPENAI_API_KEY",
  "At node start: daemon < node < config.json env < the start command's own environment.",
  "The files only fill variables the start command does not already have; a value set by",
  "hand (export / VAR=x anet node start) wins for that launch only and is never saved.",
  "set/unset only change the file: running nodes see it on their next start.",
];

function tilde(home: string, path: string): string {
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** Trailing newline from `echo` / a heredoc is not part of the value. */
export function trimPipedValue(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

function fileLine(home: string, label: string, r: SecretsFileRead): string {
  const p = tilde(home, r.path);
  if (r.status === "missing") return `${label}: ${p} (not created yet)`;
  if (r.status === "refused") return `${label}: ${p} — NOT loaded: ${r.reason}`;
  const mode = r.mode !== undefined ? r.mode.toString(8).padStart(4, "0") : "?";
  const fixed = r.repairedFromMode !== undefined ? ` (was ${r.repairedFromMode.toString(8).padStart(4, "0")}, tightened)` : "";
  return `${label}: ${p} mode ${mode}${fixed}, ${Object.keys(r.values).length} key(s)`;
}

async function doSet(ctx: SecretContext, path: string, key: string, where: string): Promise<number> {
  const { io } = ctx;
  const problem = secretKeyProblem(key);
  if (problem) { io.err(`anet secret: ${problem}`); return 1; }
  let value: string;
  try {
    value = await io.readValue(`Value for ${key} (input hidden): `);
  } catch (e: any) {
    io.err(`anet secret: ${e?.message || e}`);
    return 1;
  }
  if (!io.stdinIsTTY) value = trimPipedValue(value);
  if (value === "") { io.err("anet secret: empty value — nothing written (use unset to remove a key)"); return 1; }
  try {
    const r = setSecret(path, key, value);
    let n = 0; for (const _ of value) n++;
    io.out(`✓ ${r.replaced ? "updated" : "set"} ${key} (${where}, ${n} chars) in ${tilde(ctx.home, path)} (0600)`);
    io.out("  File only — running nodes are not touched; it takes effect on their next start (anet node restart <node>).");
    io.out("  A value exported in the start command's environment still wins over the file.");
    return 0;
  } catch (e: any) {
    io.err(`anet secret: ${e?.message || e}`);
    return 1;
  }
}

function doUnset(ctx: SecretContext, path: string, key: string, where: string): number {
  try {
    const r = unsetSecret(path, key);
    ctx.io.out(r.existed
      ? `✓ removed ${key} (${where}) from ${tilde(ctx.home, path)} — file only; running nodes keep it until their next start`
      : `${key} was not set (${where}); nothing changed`);
    return 0;
  } catch (e: any) {
    ctx.io.err(`anet secret: ${e?.message || e}`);
    return 1;
  }
}

function doList(ctx: SecretContext, node?: { dir: string; id: string; configEnvKeys: string[] }): number {
  const { io, home } = ctx;
  const g = readSecretsFile(daemonSecretsPath(home));
  const n = node ? readSecretsFile(nodeSecretsPath(node.dir)) : undefined;
  io.out(fileLine(home, "daemon (this machine)", g));
  if (node && n) io.out(fileLine(home, `node ${node.id}`, n));
  const entries = listSecretEntries(g.values, n?.values);
  if (!entries.length) { io.out("(no secrets)"); return 0; }
  const shadowed = new Set(node?.configEnvKeys ?? []);
  const w = Math.max(3, ...entries.map((e) => e.key.length));
  io.out(`${"KEY".padEnd(w)}  LAYER   LENGTH`);
  for (const e of entries) {
    const notes: string[] = [];
    if (e.overridesDaemon) notes.push("overrides daemon");
    if (shadowed.has(e.key)) notes.push("ignored: config.json env sets this key");
    io.out(`${e.key.padEnd(w)}  ${e.source.padEnd(6)}  ${String(e.length).padStart(6)}${notes.length ? `  (${notes.join("; ")})` : ""}`);
  }
  return 0;
}

/** Refuse `set KEY value` / `set KEY=value`: the value would already be in shell history. */
function argvValueRefusal(rest: string[], keyArg: string | undefined): string | null {
  if (rest.length > 0 || (keyArg && keyArg.includes("="))) {
    return "anet secret: values are never taken from the command line (shell history, ps). "
      + "Run it without the value and type it at the prompt, or pipe it: printf '%s' \"$VALUE\" | anet secret set <KEY>";
  }
  return null;
}

/** `anet secret <sub> …` — argv starts after `secret`. */
export async function secretCommand(argv: string[], ctx: SecretContext): Promise<number> {
  const [sub, ...rest] = argv;
  const { io, home } = ctx;
  const gpath = daemonSecretsPath(home);
  switch (sub) {
    case "set": {
      const [key, ...extra] = rest;
      const refusal = argvValueRefusal(extra, key);
      if (refusal) { io.err(refusal); return 2; }
      if (!key) { io.err(SECRET_USAGE.join("\n")); return 2; }
      return doSet(ctx, gpath, key, "daemon");
    }
    case "unset": {
      const [key] = rest;
      if (!key || rest.length !== 1) { io.err(SECRET_USAGE.join("\n")); return 2; }
      return doUnset(ctx, gpath, key, "daemon");
    }
    case "list": case "ls": {
      const i = rest.indexOf("--node");
      if (i >= 0) {
        const ref = rest[i + 1];
        if (!ref) { io.err("anet secret list --node <node>"); return 2; }
        const node = ctx.resolveNode(ref);
        if ("error" in node) { io.err(node.error); return 1; }
        return doList(ctx, node);
      }
      return doList(ctx);
    }
    default:
      (sub ? io.err : io.out)((sub ? `Unknown secret subcommand "${sub}".\n` : "") + SECRET_USAGE.join("\n"));
      return sub ? 2 : 0;
  }
}

/** `anet node secret <sub> <node> …` — argv starts after `secret`. */
export async function nodeSecretCommand(argv: string[], ctx: SecretContext): Promise<number> {
  const [sub, ref, ...rest] = argv;
  const { io } = ctx;
  if (!sub || !["set", "unset", "list", "ls"].includes(sub) || !ref) {
    (sub ? io.err : io.out)(SECRET_USAGE.join("\n"));
    return sub ? 2 : 0;
  }
  const node = ctx.resolveNode(ref);
  if ("error" in node) { io.err(node.error); return 1; }
  if (!existsSync(node.dir)) { io.err(`anet secret: node directory ${node.dir} does not exist`); return 1; }
  const path = nodeSecretsPath(node.dir);
  const where = `node ${node.id}`;
  if (sub === "list" || sub === "ls") return doList(ctx, node);
  const [key, ...extra] = rest;
  if (sub === "set") {
    const refusal = argvValueRefusal(extra, key);
    if (refusal) { io.err(refusal); return 2; }
    if (!key) { io.err(SECRET_USAGE.join("\n")); return 2; }
    const code = await doSet(ctx, path, key, where);
    if (code === 0 && node.configEnvKeys.includes(key)) {
      io.err(`⚠ ${key} is also in this node's config.json env, which wins over secrets files — remove it there: anet node edit ${ref}`);
    }
    return code;
  }
  if (!key || extra.length) { io.err(SECRET_USAGE.join("\n")); return 2; }
  return doUnset(ctx, path, key, where);
}

/** Read a value with echo off (TTY) or all of stdin (pipe). */
export function readSecretFromProcess(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdin.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
      stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stdin.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u0004") return done();
        if (ch === "\u007f" || ch === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
