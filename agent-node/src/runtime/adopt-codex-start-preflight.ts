import { createServer } from "node:net";
import { codexRoleNames, type CodexAdoptionScope } from "./adopt-codex-evidence.js";
import { assertCodexStopped } from "./adopt-codex-stop.js";
import { listCodexPanes } from "./adopt-codex-tmux.js";
import type { AdoptionLocalIdentity } from "./adopt-local-identity.js";
import type { AdoptedChild } from "./adopt-registry.js";
import { verifyCodexStartInputs } from "./adopt-codex-start-inputs.js";

/** A bind probe, not a reservation. B must repeat ownership checks before launch. */
async function assertPortAvailable(raw: string): Promise<void> {
  const url = new URL(raw);
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(Error("adopt_codex_port_unavailable")));
    server.listen({host:url.hostname.replace(/^\[|\]$/g, ""), port:Number(url.port), exclusive:true}, () => {
      server.close(error => error ? reject(Error("adopt_codex_port_unavailable")) : resolve());
    });
  });
}

/** Read/probe only: no spawn, signals, tmux mutation, registry or receipt writes.
 * authorityRequestId must come from a FRESH token-bound Hub response, not the
 * local receipt. Current old Hubs omit it and deliberately fail closed here.
 */
export async function preflightCodexStart(entry: AdoptedChild, identity: AdoptionLocalIdentity, scope: CodexAdoptionScope,
  authorityRequestId: unknown, stillCurrent: () => boolean): Promise<void> {
  if (authorityRequestId !== entry.request_id) throw Error("adopt_codex_binding_generation_unproven");
  const inputs = verifyCodexStartInputs(entry.codex_v2?.start_inputs, identity, scope, entry.request_id);
  if (!stillCurrent()) throw Error("adopt_binding_revoked_during_start");
  assertCodexStopped(scope);
  // A dead pane is stopped, but its name is still occupied; never inject into it.
  const names = new Set(Object.values(codexRoleNames(scope)));
  if (listCodexPanes(scope, true).some(row => names.has(row[0]))) throw Error("adopt_codex_session_conflict");
  await assertPortAvailable(inputs.appserver_url);
  if (!stillCurrent()) throw Error("adopt_binding_revoked_during_start");
}
