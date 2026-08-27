import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { streamUserEvents } from "./api";
import { selfAlias, useAuth } from "./auth";
import { Login } from "./pages/Login";
import { NodeList } from "./pages/NodeList";
import { Chat } from "./pages/Chat";

function RequireAuth({ children }: { children: JSX.Element }) {
  const utok = useAuth((s) => s.utok);
  if (!utok) return <Navigate to="/login" replace />;
  return children;
}

function Topbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="topbar">
      <h1>Agent Network</h1>
      <div className="meta">
        {user ? (
          <>
            <span>{selfAlias(user)}</span>
            <button
              className="secondary"
              style={{ marginLeft: 8, padding: "4px 10px" }}
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              logout
            </button>
          </>
        ) : (
          "guest"
        )}
      </div>
    </div>
  );
}

type DesktopNotice = {
  id: string;
  title?: string;
  message: string;
  severity: string;
};

function DesktopPushListener() {
  const { utok, networkId } = useAuth();
  const [notices, setNotices] = useState<DesktopNotice[]>([]);

  useEffect(() => {
    if (!utok || !networkId) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const ev of streamUserEvents(utok, networkId, ctrl.signal)) {
          if (ev.type !== "desktop_message") continue;
          const id = String(ev.message_id ?? crypto.randomUUID());
          setNotices((items) => [
            ...items.slice(-2),
            {
              id,
              title: typeof ev.title === "string" ? ev.title : undefined,
              message: String(ev.message ?? ""),
              severity: typeof ev.severity === "string" ? ev.severity : "info"
            }
          ]);
          window.setTimeout(() => {
            setNotices((items) => items.filter((item) => item.id !== id));
          }, 8000);
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          console.warn("[desktop] user SSE stream ended:", e);
        }
      }
    })();
    return () => ctrl.abort();
  }, [utok, networkId]);

  if (notices.length === 0) return null;
  return (
    <div className="desktop-notices" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`desktop-notice ${notice.severity}`}>
          {notice.title ? <strong>{notice.title}</strong> : null}
          <span>{notice.message}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const utok = useAuth((s) => s.utok);
  return (
    <div className="app">
      <Topbar />
      {utok ? <DesktopPushListener /> : null}
      <Routes>
        <Route path="/login" element={utok ? <Navigate to="/" replace /> : <Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <NodeList />
            </RequireAuth>
          }
        />
        <Route
          path="/chat/:alias"
          element={
            <RequireAuth>
              <Chat />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
