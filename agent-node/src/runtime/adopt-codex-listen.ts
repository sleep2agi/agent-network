import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { CodexAdoptionScope, CodexPaneSnapshot } from "./adopt-codex-evidence.js";
import { codexRoleNames } from "./adopt-codex-evidence.js";

const IPV4_LOOPBACK = "0100007F";
const IPV6_LOOPBACK = "00000000000000000000000001000000";

/** LISTEN rows only. `text` is a /proc/net/tcp or tcp6 table, header included. */
export function listenInodesInTable(text: string, address: string, port: number): Set<string> {
  const wanted = `${address}:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const result = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 10 && fields[1] === wanted && fields[3] === "0A" && fields[9]) result.add(fields[9]);
  }
  return result;
}

export function listenInodes(host: string, port: number): Set<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("adopt_codex_port_unproven");
  const spec = host === "127.0.0.1" ? ["/proc/net/tcp", IPV4_LOOPBACK] as const
    : host === "::1" ? ["/proc/net/tcp6", IPV6_LOOPBACK] as const
    : null;
  if (!spec) throw Error("adopt_codex_port_unproven");
  let text: string;
  try { text = readFileSync(spec[0], "utf8"); }
  catch { throw Error("adopt_codex_port_unproven"); }
  return listenInodesInTable(text, spec[1], port);
}

/** Every LISTEN inode for the saved loopback port must belong to the app-server tree. */
export function assertAppsrvOwnsListen(scope: CodexAdoptionScope, rawUrl: string, panes: readonly CodexPaneSnapshot[]): void {
  const url = new URL(rawUrl);
  const inodes = listenInodes(url.hostname, Number(url.port));
  if (inodes.size === 0) throw Error("adopt_codex_port_unproven");
  const pane = panes.find(item => item.sessionName === codexRoleNames(scope).appsrv);
  if (!pane) throw Error("adopt_codex_stage_missing");
  const found = new Set<string>();
  for (const pid of pane.processes.map(proc => proc.pid)) {
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); }
    catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw Error("adopt_codex_port_unproven");
    }
    for (const fd of fds) {
      try {
        const inode = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1];
        if (inode && inodes.has(inode)) found.add(inode);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw Error("adopt_codex_port_unproven");
      }
    }
  }
  if (found.size !== inodes.size) throw Error("adopt_codex_port_unproven");
}
