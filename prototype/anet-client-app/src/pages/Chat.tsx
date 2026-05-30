import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getMessages, MessageRow, sendTask, streamEvents } from "../api";
import { selfAlias, useAuth } from "../auth";
import { LiveLog } from "../components/LiveLog";

type ChatMessage =
  | { kind: "me"; id: string; text: string; ts: string }
  | { kind: "agent"; id: string; text: string; ts: string };

export function Chat() {
  const navigate = useNavigate();
  const params = useParams<{ alias: string }>();
  const targetAlias = decodeURIComponent(params.alias ?? "");
  const { utok, ntok, networkId, user } = useAuth();
  const myAlias = selfAlias(user);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const streamRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!utok) return;
    try {
      const resp = await getMessages(utok, { alias: myAlias, limit: 50, network_id: networkId });
      // server returns latest-first; flip to chronological
      const next: ChatMessage[] = resp.messages
        .slice()
        .reverse()
        .map((m: MessageRow) => ({
          kind: m.from_session === myAlias ? "me" : "agent",
          id: m.id,
          text: m.content,
          ts: m.created_at ?? ""
        }));
      // Only include messages between me and target alias (filter by from/to via inbox semantics)
      // /api/messages?alias=<me> returns my inbox; for the prototype we just show everything received.
      setMessages(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [utok, myAlias, networkId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // SSE — wake on new task pushed to my alias, then refetch messages.
  useEffect(() => {
    if (!ntok || !networkId) return;
    const ctrl = new AbortController();
    streamRef.current = ctrl;
    (async () => {
      try {
        for await (const ev of streamEvents(myAlias, ntok, networkId, ctrl.signal)) {
          if (ev.type === "new_task") {
            await refresh();
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          console.warn("[chat] SSE stream ended:", e);
        }
      }
    })();
    return () => ctrl.abort();
  }, [ntok, networkId, myAlias, refresh]);

  async function onSend() {
    if (!utok || !draft.trim()) return;
    setBusy(true);
    setError(null);
    const taskText = draft.trim();
    try {
      const resp = await sendTask(utok, {
        alias: targetAlias,
        task: taskText,
        from: myAlias,
        network_id: networkId ?? undefined
      });
      setMessages((m) => [
        ...m,
        { kind: "me", id: resp.task_id, text: taskText, ts: new Date().toISOString() }
      ]);
      setDraft("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!targetAlias) {
    return (
      <div className="page">
        <p className="error">Missing target alias.</p>
        <button className="secondary" onClick={() => navigate("/")}>Back</button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          padding: "10px 16px",
          background: "var(--panel)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        <div>
          <strong>{targetAlias}</strong>
          <div className="muted">chat as {myAlias}</div>
        </div>
        <button className="secondary" onClick={() => navigate("/")}>← Nodes</button>
      </div>

      <div className="chat-stream" style={{ flex: 1, overflowY: "auto" }}>
        {error ? <div className="error">{error}</div> : null}
        {messages.length === 0 ? (
          <p className="muted">No messages yet. Send a task to begin.</p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.kind}`}>
            <div>{m.text}</div>
            {m.ts ? <div className="meta">{m.ts}</div> : null}
          </div>
        ))}
      </div>

      <div style={{ padding: "0 12px" }}>
        <button className="live-log-toggle" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide live log" : "Show live log (tmux capture-pane)"}
        </button>
        {showLog ? <LiveLog alias={targetAlias} /> : null}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={`Send a task to ${targetAlias}…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button onClick={onSend} disabled={busy || !draft.trim()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
