import { mkdirSync, existsSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { checkNodeName } from "../shared/node-name";
import { writeCreatedOpencodeProfile } from "./opencode-create-profile";
import { childDirNameForCreate } from "./child-dir-name";
import { recordChildWorkdir } from "./child-workdir";
import type { createSessionSourceEvidenceReader } from "./session-source-evidence";
import { SOURCE_DELIVERY_CAPABILITY, isSourceNodeDelivery, type SourceNodeDelivery } from "../../../contracts/session-source-delivery";
import { createSourceResumeLauncher, type SourceResumeChild } from "./source-resume-launcher";
import { loadAndVerifyAnetBin, minimalEnv } from "./create-node-daemon";

export type SourceResumeLaunch = { configPath: string; cwd: string; existingSessionId: string;
  resumeSessionId: string; newSession: false; expectedVersion: string; bridgePolicy: "new_child_only" };
/** Private worker with concrete source-only launcher. No public queue/daemon
 * dispatch registration and no ordinary-create worker fallback. */
export function createSessionSourceProfileWorker(local: { enabled?: boolean; capability: string; daemonWorkDir: string;
  bindingHome: string; hubUrl: string; reader: ReturnType<typeof createSessionSourceEvidenceReader>;
  launch?: (input: SourceResumeLaunch) => Promise<void | SourceResumeChild>;
  nativeLaunch?: Parameters<typeof createSourceResumeLauncher>[0];
  confirmRegistration: (deliveryId: string, childToken: string) => Promise<boolean> }) {
  const children = new Map<string, SourceResumeChild>();
  return {
    async stopChild(deliveryId: string): Promise<boolean> {
      const child = children.get(deliveryId); if (!child) return false;
      await child.stop(); children.delete(deliveryId); return true;
    },
    async run(payload: SourceNodeDelivery): Promise<{ status: "registration_confirmed" | "unknown_rotation_required" | "refused"; child_node_id?: string }> {
      if (!local.enabled || local.capability !== SOURCE_DELIVERY_CAPABILITY || !isSourceNodeDelivery(payload)) return { status: "refused" };
      const name = checkNodeName(payload.child_name);
      if (!name.ok || name.name !== payload.child_name) return { status: "refused" };
      let began = false;
      const result = await local.reader.deliver(payload, async context => {
        const dir = join(context.project, ".anet", "nodes", childDirNameForCreate(payload.child_name));
        // No overwrite, auto-rotation, launch retry or adoption of prior residue.
        if (existsSync(dir)) return { status: "unknown_rotation_required" as const };
        began = true; mkdirSync(dir, { mode: 0o700 });
        // The exclusive directory is the no-relaunch tombstone. Persist it and
        // a non-secret claim before profile/runner side effects.
        const claim = openSync(join(dir, "source-delivery-claim.json"), "wx", 0o600);
        try {
          writeFileSync(claim, JSON.stringify({ delivery_id: payload.delivery_id,
            execution_id: payload.execution.execution_id, session_id: payload.session_id, child_node_id: payload.child_node_id }));
          fsyncSync(claim);
        } finally { closeSync(claim); }
        for (const path of [dir, dirname(dir)]) {
          const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        const decoded = Buffer.from(context.endpoint.authorization.replace(/^Basic /, ""), "base64").toString("utf8");
        if (!context.endpoint.authorization.startsWith("Basic ") || !decoded.startsWith("opencode:")) return { status: "refused" as const };
        const passwordFile = join(dir, "source-server-password");
        const config = { node_id: payload.child_node_id, node_name: payload.child_name, alias: payload.child_name,
          network_id: payload.execution.evidence.request.network_id, runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence",
          hub: local.hubUrl, token: payload.child_token, sessionId: payload.session_id,
          flags: { opencodeUnsafeTools: true }, // reader requires source's existing explicit opt-in
          ...(context.model ? { model: context.model } : {}),
          ...(context.sharedVariantAuthority ? { sharedVariantAuthority: context.sharedVariantAuthority } : {}),
          opencodeSharedServerUrl: context.endpoint.url, opencodeSharedServerPasswordFile: passwordFile,
          sourceDelivery: { delivery_id: payload.delivery_id, execution_id: payload.execution.execution_id,
            expires_at: payload.expires_at, server_pid: payload.execution.evidence.server.pid,
            resume_only: true, expected_version: context.version } };
        writeCreatedOpencodeProfile(dir, config, local.bindingHome);
        writeFileSync(passwordFile, decoded.slice("opencode:".length), { mode: 0o600, flag: "wx" });
        recordChildWorkdir(local.daemonWorkDir, payload.child_name, context.project);
        if (Date.now() >= payload.expires_at || !await local.reader.recheck(payload.execution.evidence.lease_id)) {
          return { status: "unknown_rotation_required" as const };
        }
        // No new/fork API is available on this runner interface.
        const launch = local.launch ?? createSourceResumeLauncher(local.nativeLaunch ?? {
          command: loadAndVerifyAnetBin(), env: { ...minimalEnv(), HOME: local.bindingHome },
        });
        const child = await launch({ configPath: join(dir, "config.json"), cwd: context.project,
          existingSessionId: payload.session_id, resumeSessionId: payload.session_id, newSession: false,
          expectedVersion: context.version, bridgePolicy: "new_child_only" });
        if (child) children.set(payload.delivery_id, child);
        let confirmed = false;
        try { confirmed = await local.confirmRegistration(payload.delivery_id, payload.child_token); }
        finally { if (!confirmed && child) { await child.stop(); children.delete(payload.delivery_id); } }
        return { status: confirmed ? "registration_confirmed" as const : "unknown_rotation_required" as const, child_node_id: payload.child_node_id };
      });
      return result ?? { status: began ? "unknown_rotation_required" : "refused" };
    },
  };
}
