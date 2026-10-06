import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AdoptionLocalIdentity } from "./adopt-local-identity.js";
import type { CodexAdoptionScope } from "./adopt-codex-evidence.js";

export function readCodexScope(identity: AdoptionLocalIdentity, uid: number): CodexAdoptionScope {
  const file = join(identity.nodeDir, "copresence-identity.json");
  const st = lstatSync(file), home = join(identity.nodeDir, "codex-home"), hs = lstatSync(home);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022) ||
      !hs.isDirectory() || hs.isSymbolicLink() || hs.uid !== uid || (hs.mode & 0o077) || realpathSync(home) !== home)
    throw Error("adopt_codex_marker_unsafe");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || typeof data.marker !== "string" || !/^[a-f0-9-]{36}$/i.test(data.marker) || data.owner_uid !== uid ||
      data.boot_id !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()) throw Error("adopt_codex_marker_invalid");
  const configured = (identity.config.env as Record<string, unknown> | undefined)?.ANET_TMUX_SOCKET;
  if (configured !== undefined && typeof configured !== "string") throw Error("adopt_codex_socket_unproven");
  return { alias: identity.alias, socket: configured as string ?? `/tmp/tmux-${uid}/default`,
    marker: data.marker, codexHome: home, workdir: identity.workdir, uid };
}
