// Daemon-side call into the native OpenCode V2 catalog reader.
// The endpoint must already exist. This module does not spawn, reload, or
// prompt a server, and it does not put authorization on the returned snapshot.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
  OpenCodeCatalogError,
  readOpenCodeCatalog,
  type CatalogError,
  type OpenCodeCatalogSnapshot,
} from "./opencode-v2-catalog";
import type { OpenCodeV2CatalogEndpoint } from "./opencode-v2-catalog-endpoint";

export interface OwnedCatalogRead {
  networkId: string;
  daemonId: string;
  /** Directory the Hub authorized, or null when the create row stored none. */
  authorizedDirectory: string | null;
  /** Project directory this daemon already owns for the child. */
  ownedProjectDirectory: string;
  endpoint: OpenCodeV2CatalogEndpoint | null;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** Expand `~` / `~/…` (and `~\…` on Windows) with this machine's home.
 * Does not import child-workdir: that module pulls the config-apply graph,
 * which the catalog image does not copy. */
function expandTilde(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 1024 || CONTROL.test(value)) return null;
  const win = process.platform === "win32";
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (win && value.startsWith("~\\"))) {
    return (win ? win32 : posix).join(homedir(), value.slice(2));
  }
  if (value.startsWith("~")) return null;
  return value;
}

function canonicalDirectory(raw: string): string | null {
  const expanded = expandTilde(raw);
  if (!expanded) return null;
  const windows = WINDOWS_DRIVE.test(expanded);
  if (process.platform === "win32") {
    if (!windows && !win32.isAbsolute(expanded)) return null;
    const resolved = win32.resolve(expanded);
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  if (expanded.startsWith("/")) {
    const resolved = posix.resolve(expanded);
    try { return realpathSync(resolved); } catch { return resolved; }
  }
  // A Windows absolute path compared on a non-Windows daemon (tests, or a
  // forwarded ack). No local disk to realpath; slash style still collapses.
  if (windows) return win32.resolve(expanded);
  return null;
}

function sameDirectory(left: string, right: string): boolean {
  const a = canonicalDirectory(left);
  const b = canonicalDirectory(right);
  if (!a || !b) return false;
  if (WINDOWS_DRIVE.test(a) || WINDOWS_DRIVE.test(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** Hub stores the create workdir literally (`/tmp/link`, not its realpath).
 * The snapshot must name that string when it is already a native absolute
 * path, so Hub can compare without walking the daemon disk. A tilde stays
 * out of the snapshot: the schema only accepts absolute directories. */
function strictNativeAbsolute(value: string): boolean {
  if (value.length < 1 || value.length > 1024 || CONTROL.test(value)) return false;
  if (WINDOWS_DRIVE.test(value)) {
    const parts = value.slice(2).split(/[\\/]/);
    return parts[0] === "" && parts.length >= 2 && parts.slice(1).every(part => part !== "" && part !== "." && part !== "..");
  }
  return value.startsWith("/") && posix.resolve(value) === value;
}

/** Read a catalog only when the loopback record belongs to the authorized
 * node. A missing record is unavailable — it is not a request to start one. */
export async function readOwnedOpenCodeV2Catalog(input: OwnedCatalogRead): Promise<
  | { ok: true; snapshot: OpenCodeCatalogSnapshot }
  | { ok: false; error: CatalogError }
> {
  if (!input.endpoint) return { ok: false, error: "unavailable" };
  const directory = input.endpoint.directory;
  if (input.authorizedDirectory) {
    if (!sameDirectory(directory, input.authorizedDirectory)) return { ok: false, error: "scope_mismatch" };
  } else if (!sameDirectory(directory, input.ownedProjectDirectory)) {
    return { ok: false, error: "scope_mismatch" };
  }
  try {
    const snapshot = await readOpenCodeCatalog({
      scope: { networkId: input.networkId, daemonId: input.daemonId, directory },
      url: input.endpoint.url,
      authorization: input.endpoint.authorization,
    });
    const authorized = input.authorizedDirectory?.trim();
    if (authorized && strictNativeAbsolute(authorized) && sameDirectory(directory, authorized)) {
      snapshot.scope.directory = authorized;
    }
    return { ok: true, snapshot };
  } catch (error) {
    const code = error instanceof OpenCodeCatalogError ? error.code : "unavailable";
    return { ok: false, error: code };
  }
}
