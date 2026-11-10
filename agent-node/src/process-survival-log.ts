import { appendFileSync, mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";

export interface ProcessSurvivalLogOptions {
  readonly logDir: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly now?: () => Date;
  readonly redact?: (text: string) => string;
  readonly exit?: (code: number) => never;
  readonly alias?: string;
  readonly appendLine?: (date: string, line: string) => void;
}

export interface ProcessSurvivalLog {
  outputBroken(): boolean;
}

function oneLineReason(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`.replace(/[\r\n]+/g, " ");
  return String(value).replace(/[\r\n]+/g, " ");
}

function fullReason(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  return String(value);
}

/**
 * Last-resort diagnostics for a broken co-presence output pipe. EPIPE is
 * survivable and subsequent normal logger output goes only to the dated file.
 * Truly fatal events retain Node's stderr stack while stderr is healthy, and
 * always leave the full stack synchronously in the dated file before exit 1.
 */
export function installProcessSurvivalLog(options: ProcessSurvivalLogOptions): ProcessSurvivalLog {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? ((text: string) => text);
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const alias = options.alias ?? "agent-node";
  let stdoutBroken = false;
  let stderrBroken = false;
  let epipeRecorded = false;
  let exitReason = "normal";
  let exiting = false;

  const decorated = (level: "INFO" | "WARN" | "ERROR", event: "stream" | "fatal" | "exit", message: string) => {
    const stamp = now().toISOString();
    return `[${stamp.slice(11, 19)}] [${level.padEnd(5)}] [${alias}] [${event}] ${message}`;
  };

  const append = (line: string) => {
    try {
      const date = now().toISOString().slice(0, 10);
      const safe = redact(line);
      if (options.appendLine) options.appendLine(date, safe);
      else {
        mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
        appendFileSync(join(options.logDir, `${date}.log`), safe + "\n", { mode: 0o600 });
      }
    } catch {
      // Last-resort logging must never turn a survivable EPIPE into an exit.
    }
  };

  const streamError = (name: "stdout" | "stderr") => (cause: NodeJS.ErrnoException) => {
    if (cause?.code === "EPIPE") {
      if (name === "stdout") stdoutBroken = true;
      else stderrBroken = true;
      if (!epipeRecorded) {
        epipeRecorded = true;
        append(decorated("WARN", "stream", `${name} EPIPE; terminal output disabled, file logging continues`));
      }
      return;
    }
    exitReason = `${name} error: ${oneLineReason(cause)}`;
    if (!exiting) {
      exiting = true;
      exit(1);
    }
  };

  stdout.on("error", streamError("stdout"));
  stderr.on("error", streamError("stderr"));

  const fatal = (kind: "uncaughtException" | "unhandledRejection", cause: unknown) => {
    if (exiting) return;
    exiting = true;
    exitReason = `${kind}: ${oneLineReason(cause)}`;
    const detail = fullReason(cause);
    append(decorated("ERROR", "fatal", `${kind}: ${detail}`));
    if (!stderrBroken) {
      try {
        writeSync(2, `${detail}\n`);
      } catch (writeError) {
        const code = (writeError as NodeJS.ErrnoException)?.code;
        if (code === "EPIPE") stderrBroken = true;
      }
    }
    exit(1);
  };
  process.on("uncaughtException", (cause) => fatal("uncaughtException", cause));
  process.on("unhandledRejection", (cause) => fatal("unhandledRejection", cause));
  process.on("exit", (code) => append(decorated(code === 0 ? "INFO" : "ERROR", "exit", `code=${code} reason=${exitReason}`)));

  return { outputBroken: () => stdoutBroken || stderrBroken };
}
