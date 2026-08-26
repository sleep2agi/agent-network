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

function safeLoopbackRemote(value: unknown): string | null {
  if (!usable(value, 2048)) return null;
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "[::1]";
    if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      || !loopback
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) return null;
    return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Data-only repair guidance for manually assembled app-server/bridge/TUI
 * topologies. The managed `anet node start --copresence` path creates the
 * thread before both clients start and therefore does not need this repair. */
export function codexTuiAlignmentNotice(
  configPath: string,
  config: Record<string, unknown>,
  threadId: string,
): CodexTuiAlignmentNotice | null {
  const remote = safeLoopbackRemote(config.codexAppServerUrl);
  const codexHome = join(dirname(configPath), "codex-home");
  const model = usable(config.model, 256) ? config.model : undefined;
  if (!remote || !usable(threadId, 1024) || !usable(codexHome, 4096)) return null;
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
