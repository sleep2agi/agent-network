import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getStatus, SessionRow } from "../api";
import { useAuth } from "../auth";

function statusClass(s: string): string {
  const v = s.toLowerCase();
  if (v === "offline") return "offline";
  if (["working", "running", "busy", "waiting_input"].includes(v)) return "working";
  if (["blocked", "error"].includes(v)) return v;
  return "idle";
}

export function NodeList() {
  const navigate = useNavigate();
  const { utok, networkId } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!utok) return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        const resp = await getStatus(utok!, networkId);
        if (cancelled) return;
        setSessions(resp.sessions);
        setError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled) timer = window.setTimeout(tick, 5000);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [utok, networkId]);

  return (
    <div className="page">
      <div className="muted" style={{ marginBottom: 8 }}>
        {loading ? "Loading..." : `${sessions.length} agent(s) in network`}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {sessions.map((s) => (
        <div
          key={s.alias}
          className="node-row"
          onClick={() => navigate(`/chat/${encodeURIComponent(s.alias)}`)}
        >
          <span className={`status-dot ${statusClass(s.status)}`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{s.alias}</div>
            <div className="runtime">
              {s.runtime ?? "unknown runtime"}
              {s.model ? ` · ${s.model}` : ""}
              {" · "}
              {s.status}
            </div>
            {s.task ? (
              <div
                className="muted"
                style={{
                  marginTop: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {s.task}
              </div>
            ) : null}
          </div>
        </div>
      ))}
      {!loading && sessions.length === 0 && !error ? (
        <p className="muted">No agents online yet. Start a node first: <code>anet node start &lt;alias&gt;</code></p>
      ) : null}
    </div>
  );
}
