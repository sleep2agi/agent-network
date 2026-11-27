import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Grok and Antigravity use the same packaged (or source) local upload bridge. */
export function resolveAcpUploadMcpEntry(moduleUrl: string, opts: {
  exists?: (path: string) => boolean;
  windows?: boolean;
  execPath?: string;
  bunBin?: string;
} = {}): { uploadMcpCommand?: string; uploadMcpArgs?: string[] } {
  const exists = opts.exists ?? existsSync;
  for (const ext of ["js", "ts"] as const) {
    const path = fileURLToPath(new URL(`./upload-file-mcp-stdio.${ext}`, moduleUrl), { windows: opts.windows });
    if (exists(path)) return {
      uploadMcpCommand: ext === "ts" ? (opts.bunBin || "bun") : (opts.execPath ?? process.execPath),
      uploadMcpArgs: [path],
    };
  }
  return {};
}
