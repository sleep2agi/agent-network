/** Standard ACP prompt result takes precedence over the legacy Grok notification. */
export function acpPromptStopReason(response: unknown, notification?: string): string | undefined {
  const reason = (response as { stopReason?: unknown } | null)?.stopReason;
  return typeof reason === "string" ? reason : notification;
}

export class AcpTurnCancelledError extends Error {
  constructor(readonly partialReplyText: string) {
    super("ACP turn was cancelled");
    this.name = "AbortError";
  }
}

export function isTurnAbort(error: unknown): boolean {
  const e = error as { name?: string; code?: string; upstreamName?: string; upstreamMessage?: string; message?: string } | null;
  const name = e?.upstreamName ?? e?.name;
  const message = e?.upstreamMessage ?? e?.message ?? (typeof error === "string" ? error : "");
  if (name === "TimeoutError" || e?.code === "opencode_copresence_timeout"
      || /^(?:ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)$/.test(e?.code ?? "")
      || /\b(?:timed?\s*out|timeout|watchdog|disconnected|connection (?:closed|reset|lost)|socket (?:closed|hang up))\b/i.test(message)) return false;
  if (name === "MessageAbortedError" || name === "AbortError" || name === "aborted" || name === "interrupted") return true;
  // Inspect the underlying error, not the rendered reply (which may include
  // generated text containing these words).
  return /\b(?:interrupted|aborted)\b/i.test(message);
}

/** One execution, not just one task ID: a retry/replay of the same ID gets a fresh receipt. */
export class UserStoppedTurn {
  stoppedAt: number | null = null;
  codexTurnId: string | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly taskId: string | null) {}

  interrupt<T extends { ok: boolean; interrupted?: boolean }>(run: () => T | Promise<T>): Promise<T> {
    // Register before invoking the runtime. The runtime can report its abort
    // before the interrupt request returns its positive acknowledgement.
    const result = Promise.resolve().then(run).then(out => {
      if (out.ok && out.interrupted) this.stoppedAt ??= Date.now();
      return out;
    });
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }

  async reply(error: unknown): Promise<{ text: string; failed: false } | null> {
    if (!isTurnAbort(error)) return null;
    const partial = (error as { partialReplyText?: unknown } | null)?.partialReplyText;
    if (this.stoppedAt === null) await Promise.allSettled([...this.pending]);
    if (this.stoppedAt === null) return null;
    const text = typeof partial === "string" ? partial.trim() : "";
    return { text: text ? `已按要求停止。\n\n停止前已产出：\n${text}` : "已按要求停止。", failed: false };
  }
}
