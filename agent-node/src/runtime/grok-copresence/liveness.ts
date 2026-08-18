import { lstatSync } from "fs";
import { basename } from "path";

/**
 * Hub `report_status` enum (server/src/tools.ts). Copresence must never
 * present a dead or unready TUI as idle/working — that is the #811
 * false-idle shape.
 */
export const GROK_COPRESENCE_HUB_STATUSES = [
  "working",
  "idle",
  "blocked",
  "error",
  "waiting_input",
  "offline",
] as const;

export type GrokCopresenceHubStatus = (typeof GROK_COPRESENCE_HUB_STATUSES)[number];

export function isGrokCopresenceHubStatus(value: string): value is GrokCopresenceHubStatus {
  return (GROK_COPRESENCE_HUB_STATUSES as readonly string[]).includes(value);
}

export interface GrokCopresenceLivenessSource {
  readonly isRunning: boolean;
  readonly tuiReady: boolean;
  readonly attachSocket: string;
  readonly leaderSocket: string;
}

export interface GrokCopresenceSocketView {
  present: boolean;
  named: boolean;
}

export interface GrokCopresenceLiveness {
  tuiReady: boolean;
  childAlive: boolean;
  attach: GrokCopresenceSocketView;
  leader: GrokCopresenceSocketView;
  usable: boolean;
}

export type GrokSocketInspector = (path: string) => boolean;

/** True only for a real Unix socket at `path`. Leftover files / missing paths are not present. */
export function grokSocketIsPresent(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * Named sockets are `attach.sock` / `leader.sock`, or the documented
 * short-path fallback `a.sock` / `l.sock` when the Unix path-length
 * budget forces `grokCopresenceSocketPaths` under `/tmp`.
 */
export function isNamedGrokCopresenceSocket(path: string, role: "attach" | "leader"): boolean {
  const name = basename(path);
  if (role === "attach") return name === "attach.sock" || name === "a.sock";
  return name === "leader.sock" || name === "l.sock";
}

export function describeGrokCopresenceLiveness(
  session: GrokCopresenceLivenessSource | null | undefined,
  inspect: GrokSocketInspector = grokSocketIsPresent,
): GrokCopresenceLiveness {
  if (!session) {
    return {
      tuiReady: false,
      childAlive: false,
      attach: { present: false, named: false },
      leader: { present: false, named: false },
      usable: false,
    };
  }
  const attachNamed = isNamedGrokCopresenceSocket(session.attachSocket, "attach");
  const leaderNamed = isNamedGrokCopresenceSocket(session.leaderSocket, "leader");
  const attachPresent = inspect(session.attachSocket);
  const leaderPresent = inspect(session.leaderSocket);
  const tuiReady = session.tuiReady === true;
  const childAlive = session.isRunning === true;
  return {
    tuiReady,
    childAlive,
    attach: { present: attachPresent, named: attachNamed },
    leader: { present: leaderPresent, named: leaderNamed },
    usable: childAlive && tuiReady && attachPresent && leaderPresent && attachNamed && leaderNamed,
  };
}

export function resolveGrokCopresenceHubStatus(
  liveness: Pick<GrokCopresenceLiveness, "usable">,
  requested: GrokCopresenceHubStatus,
): GrokCopresenceHubStatus {
  if (requested === "offline") return "offline";
  if (!liveness.usable && (requested === "idle" || requested === "working")) {
    return "blocked";
  }
  return requested;
}
