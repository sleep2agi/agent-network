import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createNode,
  getStatus,
  HostSupervisor,
  listHostSupervisors,
  restartNode,
  SessionRow,
  stopNode
} from "../api";
import { useAuth } from "../auth";

function statusClass(s: string): string {
  const v = s.toLowerCase();
  if (v === "offline") return "offline";
  if (["working", "running", "busy", "waiting_input"].includes(v)) return "working";
  if (["blocked", "error"].includes(v)) return v;
  return "idle";
}

const RUNTIME_MODELS: Record<string, string> = {
  "claude-agent-sdk": "claude-sonnet-4-6",
  "codex-sdk": "gpt-5.4",
  "grok-build-acp": "grok-4"
};

const FALLBACK_RUNTIMES = Object.keys(RUNTIME_MODELS);

export function NodeList() {
  const navigate = useNavigate();
  const { utok, networkId } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [daemons, setDaemons] = useState<HostSupervisor[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [nodeName, setNodeName] = useState("");
  const [runtime, setRuntime] = useState("claude-agent-sdk");
  const [daemonId, setDaemonId] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refreshAll() {
    if (!utok) return;
    const [statusResp, daemonResp] = await Promise.all([
      getStatus(utok, networkId),
      listHostSupervisors(utok, networkId)
    ]);
    setSessions(statusResp.sessions);
    setDaemons(daemonResp.daemons);
    if (!daemonId && daemonResp.daemons.length > 0) {
      const firstOnline = daemonResp.daemons.find((d) => d.online) ?? daemonResp.daemons[0];
      setDaemonId(firstOnline.daemon_node_id);
      const firstRuntime = (firstOnline.runtimes_supported?.length ? firstOnline.runtimes_supported : FALLBACK_RUNTIMES)[0];
      if (firstRuntime) setRuntime(firstRuntime);
    }
  }

  useEffect(() => {
    if (!utok) return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      try {
        await refreshAll();
        if (cancelled) return;
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

  const selectedDaemon = daemons.find((d) => d.daemon_node_id === daemonId) ?? null;
  const runtimeOptions = selectedDaemon?.runtimes_supported?.length
    ? selectedDaemon.runtimes_supported
    : FALLBACK_RUNTIMES;

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!utok || !daemonId || !nodeName.trim()) return;
    const name = nodeName.trim();
    setActionBusy("create");
    setError(null);
    setNotice(null);
    try {
      const resp = await createNode(utok, {
        daemon_node_id: daemonId,
        name,
        runtime,
        model: RUNTIME_MODELS[runtime] ?? "default",
        network_id: networkId
      });
      if (!resp.ok) throw new Error(resp.message || resp.error || "create_node failed");
      setNotice(`Create dispatched: ${name} (${resp.request_id})`);
      setNodeName("");
      setShowCreate(false);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function onNodeAction(kind: "restart" | "stop", node: SessionRow) {
    if (!utok || !node.node_id) return;
    setActionBusy(`${kind}:${node.node_id}`);
    setError(null);
    setNotice(null);
    try {
      const resp = kind === "restart"
        ? await restartNode(utok, node.node_id, networkId)
        : await stopNode(utok, node.node_id, networkId);
      if (!resp.ok) throw new Error(resp.message || resp.error || `${kind}_node failed`);
      setNotice(`${kind === "restart" ? "Restart" : "Stop"} dispatched for ${node.alias}`);
      await refreshAll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="page">
      <div className="list-header">
        <div>
          <div className="muted">
            {loading ? "Loading..." : `${sessions.length} agent(s) in network`}
          </div>
          <div className="muted">{daemons.filter((d) => d.online).length} host daemon(s) online</div>
        </div>
        <button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "Close" : "Create node"}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {showCreate ? (
        <form className="card" onSubmit={onCreate}>
          <label htmlFor="node-name">Node name</label>
          <input
            id="node-name"
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="demo-bot"
            pattern="[a-z][a-z0-9_-]{0,63}"
            required
          />
          <label htmlFor="runtime">Runtime</label>
          <select id="runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            {runtimeOptions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <label htmlFor="daemon">Host daemon</label>
          <select
            id="daemon"
            value={daemonId}
            onChange={(e) => {
              const nextId = e.target.value;
              setDaemonId(nextId);
              const d = daemons.find((item) => item.daemon_node_id === nextId);
              const nextRuntime = (d?.runtimes_supported?.length ? d.runtimes_supported : FALLBACK_RUNTIMES)[0];
              if (nextRuntime) setRuntime(nextRuntime);
            }}
            required
          >
            {daemons.map((d) => (
              <option key={d.daemon_node_id} value={d.daemon_node_id} disabled={!d.online}>
                {d.hostname || d.alias} {d.online ? "" : "(offline)"}
              </option>
            ))}
          </select>
          <button type="submit" disabled={actionBusy === "create" || !daemonId || !nodeName.trim()}>
            {actionBusy === "create" ? "Creating..." : "Create"}
          </button>
          {daemons.length === 0 ? (
            <p className="muted">No host daemon is available in this network.</p>
          ) : null}
        </form>
      ) : null}

      {sessions.map((s) => (
        <div
          key={s.alias}
          className="node-row"
        >
          <div
            className="node-main"
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
          <div className="node-actions">
            <button
              className="secondary"
              disabled={!s.node_id || actionBusy === `restart:${s.node_id}`}
              onClick={() => onNodeAction("restart", s)}
            >
              {actionBusy === `restart:${s.node_id}` ? "Restarting" : "Restart"}
            </button>
            <button
              className="secondary danger"
              disabled={!s.node_id || actionBusy === `stop:${s.node_id}`}
              onClick={() => onNodeAction("stop", s)}
            >
              {actionBusy === `stop:${s.node_id}` ? "Stopping" : "Stop"}
            </button>
          </div>
        </div>
      ))}
      {!loading && sessions.length === 0 && !error ? (
        <p className="muted">No agents online yet. Use Create node to start one on an available host daemon.</p>
      ) : null}
    </div>
  );
}
