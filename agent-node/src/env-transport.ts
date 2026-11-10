/**
 * #1510 (#2004 摘出) — how this node reaches the Hub, as a value the Hub can
 * reason about before forwarding a secret.
 *
 * Why a separate signal: the Hub cannot see the last hop. A node may be on the
 * same machine (loopback), behind TLS, or talking plain HTTP over a LAN. Only
 * the node knows which, and only the node's own report is trustworthy for it.
 *
 *   loopback — the Hub URL's host is a loopback address (127.0.0.0/8, ::1,
 *              localhost). Nothing leaves the machine.
 *   https    — TLS end to end.
 *   plain    — anything else (http to a remote host, ws://, a unix socket path
 *              we cannot classify). Treated as the weakest bucket on purpose:
 *              an unparseable URL must not be reported as safe.
 *
 * This is REPORTING ONLY for now: no path refuses a write because of it. The
 * gate that consumes it is a separate change so that turning it on is a
 * deliberate act, not a side effect of a node upgrade.
 */
export type EnvTransport = "loopback" | "https" | "plain";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function classifyHubTransport(hubUrl: string | undefined | null): EnvTransport {
  const raw = (hubUrl ?? "").trim();
  if (!raw) return "plain";
  let url: URL;
  try { url = new URL(raw); } catch { return "plain"; }
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return "loopback";
  // 127.0.0.0/8 is all loopback, not just .0.1
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return "loopback";
  if (url.protocol === "https:" || url.protocol === "wss:") return "https";
  return "plain";
}
