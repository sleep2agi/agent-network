import { dirname, join } from "path";

export interface CodexTuiAlignmentNotice {
  codexHome: string;
  remote: string;
  threadId: string;
  model?: string;
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
  if (!remote) return null;
  return {
    codexHome: join(dirname(configPath), "codex-home"),
    remote,
    threadId,
    ...(typeof config.model === "string" && config.model ? { model: config.model } : {}),
  };
}
