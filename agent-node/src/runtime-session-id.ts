/**
 * Resumeable runtime session id reported as `report_status.session_id`.
 *
 * This is not the Hub row key (`resume_id`: `sdk-<node>` / `cc-<node>`).
 * Hub stores it on `sessions.session_id` and returns it on the full
 * `GET /api/status` projection (the node page already polls `?alias=`).
 * `?light=1` does not include the column.
 *
 * Omit when the runtime has not minted a session. Never invent one.
 * Hub's schema is `z.string().max(200)`; a longer value rejects the whole report.
 */
export const RUNTIME_SESSION_ID_MAX = 200;

export interface RuntimeSessionSources {
  /** agent-node internal bucket: claude | codex | grok | opencode | codex-app-server */
  runtime: string;
  /** claude-agent-sdk: SDK init `session_id` (the value `Options.resume` uses). */
  claudeSessionId?: string | null;
  /** grok-build-acp / grok-build-cli: ACP sessionId or the CLI `--session-id` / `--resume` id. */
  grokSessionId?: string | null;
  /** opencode-cli: ACP or co-presence session id. */
  opencodeSessionId?: string | null;
  /** codex-app-server: Codex thread id (`codexThreadId`). */
  codexAppServerThreadId?: string | null;
  /** codex-sdk: `Thread.id` once the SDK thread exists. */
  codexSdkThreadId?: string | null;
  /** codex stdio lane: thread recorded after a turn that wrote a rollout. */
  codexStdioRecordedThreadId?: string | null;
  /** Config session captured at boot, used to resume before the live object exists. */
  bootSessionId?: string | null;
  /** `ANET_CODEX_STDIO_DIRECT=1` — the stdio lane owns the thread id. */
  codexStdioDirect?: boolean;
}

export function boundedRuntimeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s || s.length > RUNTIME_SESSION_ID_MAX) return undefined;
  return s;
}

/** The id an operator would pass back to that runtime's resume flag. Undefined if none yet. */
export function runtimeResumeSessionId(src: RuntimeSessionSources): string | undefined {
  switch (src.runtime) {
    case "grok":
      return boundedRuntimeSessionId(src.grokSessionId);
    case "claude":
      return boundedRuntimeSessionId(src.claudeSessionId);
    case "opencode":
      return boundedRuntimeSessionId(src.opencodeSessionId);
    case "codex-app-server":
      return boundedRuntimeSessionId(src.codexAppServerThreadId);
    case "codex":
      if (src.codexStdioDirect) {
        return boundedRuntimeSessionId(src.codexStdioRecordedThreadId)
          ?? boundedRuntimeSessionId(src.bootSessionId);
      }
      return boundedRuntimeSessionId(src.codexSdkThreadId)
        ?? boundedRuntimeSessionId(src.bootSessionId);
    default:
      return undefined;
  }
}
