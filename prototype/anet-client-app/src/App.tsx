import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
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

export function App() {
  const utok = useAuth((s) => s.utok);
  return (
    <div className="app">
      <Topbar />
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
