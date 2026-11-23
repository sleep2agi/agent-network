// Comparing workspace paths the way the platform does.
//
// On POSIX a path is its bytes: equality is string equality, exactly as before. On Windows the same
// directory has many spellings — `D:\ws`, `d:\ws`, `D:/ws`, `D:\ws\` — and an OpenCode server may
// answer with a different one than the node asked with. Treating those as different workspaces
// refuses a node its own session.

import { win32 } from "node:path";

/** A stable comparison key. Not for display, and never written anywhere. */
export function workspaceKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? win32.resolve(path).toLowerCase() : path;
}

export function sameWorkspacePath(a: unknown, b: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  return workspaceKey(a, platform) === workspaceKey(b, platform);
}

/** `location` is the workspace or somewhere inside it. `/ws-2` is not inside `/ws`; another drive never is. */
export function isWithinWorkspacePath(location: unknown, workspace: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof location !== "string" || !location || !workspace) return false;
  if (platform === "win32") {
    const rel = win32.relative(workspaceKey(workspace, platform), workspaceKey(location, platform));
    return rel === "" || (!win32.isAbsolute(rel) && !rel.split("\\").includes(".."));
  }
  if (location === workspace) return true;
  const base = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return location.startsWith(base) && !location.slice(base.length).split("/").includes("..");
}

/**
 * The value for the `x-opencode-directory` request header.
 *
 * An HTTP header value is bytes: Node's fetch refuses anything above U+00FF ("Cannot convert
 * argument to a ByteString"), so a workspace such as `D:\工作 目录` could not be sent at all.
 * OpenCode 2.0.22 URL-decodes this header (measured on Windows 11: the percent-encoded form came
 * back as the original path; a `?directory=` query was ignored). Paths that fit in a header are
 * sent exactly as before, so nothing changes for workspaces that already worked.
 */
export function opencodeDirectoryHeader(directory: string): string {
  return /[^\x20-\x7e]/.test(directory) ? encodeURIComponent(directory) : directory;
}
