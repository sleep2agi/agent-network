// The session-source lanes (directory / fork / project / attach) carry one-shot
// secrets, so their worker only talks to an HTTPS Hub or a loopback HTTP Hub.
// Kept in a tiny module so the CLI can check it before advertising capabilities
// without loading the whole transport worker.
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Same rule the transport worker enforces: https, or http on loopback; bare origin only. */
export function isSecureSourceHubUrl(url: string): boolean {
  let hub: URL;
  try { hub = new URL(url); } catch { return false; }
  if (hub.username || hub.password || hub.search || hub.hash || (hub.pathname !== "/" && hub.pathname !== "")) return false;
  return hub.protocol === "https:" || (hub.protocol === "http:" && LOOPBACK.includes(hub.hostname));
}
