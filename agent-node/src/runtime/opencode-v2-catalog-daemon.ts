// Daemon-side call into the native OpenCode V2 catalog reader.
// The endpoint must already exist. This module does not spawn, reload, or
// prompt a server, and it does not put authorization on the returned snapshot.

import { resolve } from "node:path";
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

function sameDirectory(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
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
    return { ok: true, snapshot };
  } catch (error) {
    const code = error instanceof OpenCodeCatalogError ? error.code : "unavailable";
    return { ok: false, error: code };
  }
}
