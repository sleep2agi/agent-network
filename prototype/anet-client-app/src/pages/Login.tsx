import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { selfAlias, useAuth } from "../auth";
import { getNetworks, getNodeToken, login } from "../api";

export function Login() {
  const navigate = useNavigate();
  const setSession = useAuth((s) => s.setSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const resp = await login(email.trim(), password);
      const user = resp.user;
      // Pick first network and provision ntok_ for SSE.
      const networksResp = await getNetworks(resp.token);
      const firstNet = networksResp.networks[0];
      let ntok: string | null = null;
      let networkId: string | null = null;
      if (firstNet) {
        try {
          const ntResp = await getNodeToken(resp.token, firstNet.id, selfAlias(user));
          ntok = ntResp.token;
          networkId = firstNet.id;
        } catch (e) {
          console.warn("[login] node-token failed, SSE will be unavailable:", e);
        }
      }
      setSession({ utok: resp.token, user, ntok, networkId });
      navigate("/", { replace: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <form className="login-card" onSubmit={onSubmit}>
        <h2 style={{ marginTop: 0 }}>Sign in</h2>
        <p className="muted">
          Use your commhub email + password. Need an account? Ask your network admin for an invite.
        </p>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error ? <div className="error">{error}</div> : null}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
