import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";

export interface ProcessSurvivalLogOptions {
  readonly logDir: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly now?: () => Date;
  readonly redact?: (text: string) => string;
  readonly exit?: (code: number) => never;
}

export interface ProcessSurvivalLog {
  outputBroken(): boolean;
}

function oneLineReason(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`.replace(/[\r\n]+/g, " ");
  return String(value).replace(/[\r\n]+/g, " ");
}

/**
 * Last-resort diagnostics that never use stdout/stderr themselves. A broken
 * co-presence tee closes the bridge's stdout pipe; EPIPE is survivable and
 * subsequent normal logger output goes only to the dated file. Truly fatal
 * process events keep exit=1 but leave one synchronous reason in that file.
 */
export function installProcessSurvivalLog(options: ProcessSurvivalLogOptions): ProcessSurvivalLog {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const redact = options.redact ?? ((text: string) => text);
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  let broken = false;
  let exitReason = "normal";
  let exiting = false;

  const append = (line: string) => {
    try {
      mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
      const date = now().toISOString().slice(0, 10);
      appendFileSync(join(options.logDir, `${date}.log`), redact(line) + "\n", { mode: 0o600 });
    } catch {
      // Last-resort logging must never turn a survivable EPIPE into an exit.
    }
  };

  const streamError = (name: "stdout" | "stderr") => (cause: NodeJS.ErrnoException) => {
    if (cause?.code === "EPIPE") {
      broken = true;
      append(`[stream] ${name} EPIPE; terminal output disabled, file logging continues`);
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
    exit(1);
  };
  process.on("uncaughtException", (cause) => fatal("uncaughtException", cause));
  process.on("unhandledRejection", (cause) => fatal("unhandledRejection", cause));
  process.on("exit", (code) => append(`[exit] code=${code} reason=${exitReason}`));

  return { outputBroken: () => broken };
}
