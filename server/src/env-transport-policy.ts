// #1510 — the switch for the secret-transport gate.
//
//   (unset) / "log" — record what a gate WOULD refuse; refuse nothing.
//   "enforce"       — refuse secret writes to nodes that report `plain`.
//   "off"           — do nothing at all (no recording either).
//
// Reading the env on every call (like the stale-open sweep) means an operator can
// change the mode without a code change and tests can flip it per case.
export type EnvTransportMode = "off" | "log" | "enforce";

export function getEnvTransportMode(env: Record<string, string | undefined> = process.env): EnvTransportMode {
  const raw = (env.ANET_SECRET_TRANSPORT_GATE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  return "log";
}

/** True when a write to a node reporting `plain` must be refused. */
export function refusesPlainTransport(transport: string | null, env: Record<string, string | undefined> = process.env): boolean {
  return getEnvTransportMode(env) === "enforce" && transport === "plain";
}
