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
/**
 * 把投递过程中被吞掉的异常转成**可读原因**。
 *
 * 2026-11-10 实测（CI 同款镜像）：交接守卫抛 `source_resume_claim_handoff_refused`，
 * 被 deliver() 吞掉后 worker 只返回 unknown_rotation_required ——
 * 客户端显示「结果未知，禁止自动重放」，运维在日志里也看不到是哪个守卫拒的。
 * status 不能改（子目录可能已建，谎报失败会引导用户重试并留下残留），但原因必须可读。
 */
/** 早退路径的原因标签。
 *
 * `unknown_rotation_required` 是**保守**的 status（子目录可能已建，不能谎报失败），
 * 但保守不等于不可诊断：这条 status 有 4 条互不相同的前置失败，运维此前只能看到一个
 * 光秃秃的枚举，四种情况在日志里长得一模一样。
 *
 * 只加日志、不改 status（status 语义由客户端重放策略依赖，见 #4448）。
 */
const UNKNOWN_REASONS = {
  child_dir_residue: '子目录已存在（上一轮残留），按不重放原则拒绝',
  lease_expired: '投递已过期（expires_at 早于当前时间）',
  lease_recheck_failed: '租约复核失败（recheck 返回 false）',
  registration_unconfirmed: '子进程已拉起但注册未确认（confirmRegistration 返回 false）',
} as const;
type UnknownReason = keyof typeof UNKNOWN_REASONS;

export const sourceDeliveryFailureReason = (e: unknown): string => {
  const any = e as { message?: unknown } | null;
  const msg = typeof any?.message === 'string' ? any.message : '';
  return msg.length > 0 ? msg.slice(0, 200) : 'no reason captured';
};

export function createSessionSourceProfileWorker(local: { enabled?: boolean; capability: string; daemonWorkDir: string;
  bindingHome: string; hubUrl: string; reader: ReturnType<typeof createSessionSourceEvidenceReader>;
  launch?: (input: SourceResumeLaunch) => Promise<void | SourceResumeChild>;
  nativeLaunch?: Parameters<typeof createSourceResumeLauncher>[0];
  confirmRegistration: (deliveryId: string, childToken: string) => Promise<boolean> }) {
  const children = new Map<string, SourceResumeChild>();
  const unknown = (why: UnknownReason) => {
    console.error(`[source-delivery] unknown: ${why} — ${UNKNOWN_REASONS[why]}`);
    return { status: "unknown_rotation_required" as const };
  };
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
      // 兜底成 unknown_rotation_required 之前先**把原因留住**。
      //
      // 2026-11-10 实测（CI 同款镜像）：交接守卫抛 `source_resume_claim_handoff_refused`，
      // 被 deliver() 吞掉后 worker 只返回 unknown —— 客户端显示「结果未知，禁止自动重放」，
      // 运维也看不到是哪个守卫拒的。status 仍然保守（子目录可能已建，不能谎报失败），
      // 但原因必须可读。
      let failReason: string | null = null;
      const result = await local.reader.deliver(payload, async context => { try {
        const dir = join(context.project, ".anet", "nodes", childDirNameForCreate(payload.child_name));
        // No overwrite, auto-rotation, launch retry or adoption of prior residue.
        if (existsSync(dir)) return unknown("child_dir_residue");
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
        if (Date.now() >= payload.expires_at) return unknown("lease_expired");
        if (!await local.reader.recheck(payload.execution.evidence.lease_id)) return unknown("lease_recheck_failed");
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
        if (!confirmed) return { ...unknown("registration_unconfirmed"), child_node_id: payload.child_node_id };
        return { status: "registration_confirmed" as const, child_node_id: payload.child_node_id };
      } catch (e) { failReason = sourceDeliveryFailureReason(e); console.error(`[source-delivery] refused: ${failReason}`); throw e; } });
      if (result === undefined && began) console.error(`[source-delivery] delivery aborted after claim: ${failReason ?? 'no reason captured'}`);
      return result ?? { status: began ? "unknown_rotation_required" : "refused" };
    },
  };
}
