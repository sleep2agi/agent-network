import { dirname, join } from "path";

export interface CodexTuiAlignmentNotice {
  codexHome: string;
  remote: string;
  threadId: string;
  model?: string;
  posixCommand: string;
  powershellCommand: string;
}

function usable(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function sh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Data-only repair guidance for manually assembled app-server/bridge/TUI
 * topologies. The managed `anet node start --copresence` path creates the
 * thread before both clients start and therefore does not need this repair. */
export function codexTuiAlignmentNotice(
  configPath: string,
  config: Record<string, unknown>,
  threadId: string,
): CodexTuiAlignmentNotice | null {
  const remote = typeof config.codexAppServerUrl === "string" ? config.codexAppServerUrl : "";
  const codexHome = join(dirname(configPath), "codex-home");
  const model = usable(config.model, 256) ? config.model : undefined;
  if (!usable(remote, 2048) || !usable(threadId, 1024) || !usable(codexHome, 4096)) return null;
  const modelPosix = model ? ` -m ${sh(model)}` : "";
  const modelPowerShell = model ? ` -m ${ps(model)}` : "";
  return {
    codexHome,
    remote,
    threadId,
    ...(model ? { model } : {}),
    posixCommand: `export CODEX_HOME=${sh(codexHome)}; codex resume --remote ${sh(remote)} ${sh(threadId)}${modelPosix}`,
    powershellCommand: `$env:CODEX_HOME=${ps(codexHome)}; codex resume --remote ${ps(remote)} ${ps(threadId)}${modelPowerShell}`,
  };
}
