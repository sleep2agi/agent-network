// Requests to this machine never go through a proxy.
//
// With NODE_USE_ENV_PROXY=1 (or any proxy-aware client) and HTTP_PROXY set, a request to
// 127.0.0.1 is sent to the proxy unless NO_PROXY names loopback. A node talks to local servers
// with credentials in the request — the shared OpenCode Server's password, the per-workspace
// CommHub proxy's bearer — and those must not be handed to a proxy process. Measured on a
// Windows machine whose NO_PROXY listed only company domains: loopback calls went to the proxy.
//
// Node's proxy agent re-reads NO_PROXY when it changes, so extending it at startup is enough.

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/** `value` with the loopback names added; existing entries and their order are kept. */
export function withLoopbackNoProxy(value: string | undefined): string {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes("*")) return entries.join(",");
  const have = new Set(entries.map((entry) => entry.toLowerCase()));
  return [...entries, ...LOOPBACK.filter((name) => !have.has(name))].join(",");
}

/** Applies it to this process and, by inheritance, to every child it starts. */
export function exemptLoopbackFromProxy(env: NodeJS.ProcessEnv = process.env): void {
  const value = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = value;
  env.no_proxy = value;
}
