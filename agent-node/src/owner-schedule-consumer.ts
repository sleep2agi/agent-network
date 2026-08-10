import {
  applyOwnerScheduleIntent,
  finalizeOwnerScheduleIntent,
  OwnerScheduleSafetyError,
  recordOwnerScheduleAudit,
  type CrontabAdapter,
  type ScheduleEditIntent,
} from "./owner-schedule-control.js";
import { parseExternalSchedulePatch } from "./shared/external-schedule-contract.js";

const INTENT_ID_RE = /^sei_[0-9a-f-]+$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

type FetchLike = typeof fetch;

export type OwnerScheduleConsumer = {
  enabled: boolean;
  trigger(): Promise<void>;
  stop(): void;
};

function boundedIntent(value: unknown, expectedNodeId: string): ScheduleEditIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnerScheduleSafetyError("invalid Hub schedule intent");
  const row = value as Record<string, unknown>;
  if (row.status !== "delivered" || typeof row.intent_id !== "string" || !INTENT_ID_RE.test(row.intent_id)
    || row.node_id !== expectedNodeId || typeof row.schedule_id !== "string" || !ID_RE.test(row.schedule_id)
    || !Number.isSafeInteger(row.base_revision) || Number(row.base_revision) < 0) {
    throw new OwnerScheduleSafetyError("invalid Hub schedule intent");
  }
  return {
    intent_id: row.intent_id,
    node_id: expectedNodeId,
    schedule_id: row.schedule_id,
    base_revision: Number(row.base_revision),
    patch: parseExternalSchedulePatch(row.patch),
  };
}

function errorCode(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  if (/revision conflict/.test(message)) return "revision_conflict";
  if (/not managed/.test(message)) return "schedule_not_managed";
  if (/invalid_cron|invalid_patch|invalid_enabled/.test(message)) return "invalid_patch";
  if (error instanceof OwnerScheduleSafetyError) return "local_safety_refused";
  return "local_apply_failed";
}

export function createOwnerScheduleConsumer(options: {
  enabled: boolean;
  hubUrl: string;
  token: string | (() => string);
  nodeId: string;
  configPath: string;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  crontabAdapter?: CrontabAdapter;
  log?: (message: string) => void;
}): OwnerScheduleConsumer {
  if (!options.enabled) return { enabled: false, trigger: async () => {}, stop: () => {} };
  const getToken = typeof options.token === "function" ? options.token : () => options.token as string;
  if (!options.hubUrl || !getToken().startsWith("ntok_") || !ID_RE.test(options.nodeId) || !options.configPath) {
    throw new OwnerScheduleSafetyError("owner schedule control requires hub, bound ntok, node_id and config path");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  const endpoint = `${options.hubUrl.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(options.nodeId)}/external-schedule-edits`;
  let stopped = false;
  let running: Promise<void> | null = null;

  const run = async () => {
    if (stopped) return;
    const token = getToken();
    if (!token.startsWith("ntok_")) throw new OwnerScheduleSafetyError("owner schedule control lost its bound ntok");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const response = await fetchImpl(`${endpoint}/pending`, { headers });
    if (!response.ok) throw new OwnerScheduleSafetyError(`schedule intent pull failed: ${response.status}`);
    const payload = await response.json() as any;
    if (!payload?.ok || payload.intent == null) return;
    const intent = boundedIntent(payload.intent, options.nodeId);
    let ack: Record<string, unknown>;
    let journalCreated = false;
    try {
      const applied = applyOwnerScheduleIntent({
        configPath: options.configPath,
        expectedNodeId: options.nodeId,
        intent,
        adapter: options.crontabAdapter,
      });
      journalCreated = true;
      ack = { status: "applied", result_revision: applied.result_revision };
    } catch (error) {
      const code = errorCode(error);
      if (/rollback failed|recovery conflict|required/.test(String(error instanceof Error ? error.message : error))) {
        log(`owner schedule intent ${intent.intent_id} requires local recovery`);
        return;
      }
      // A journal may have been created before a verified rollback. It is
      // finalized only after Hub accepts the rejected terminal state.
      journalCreated = true;
      ack = { status: "rejected", error_code: code };
    }
    const ackResponse = await fetchImpl(`${endpoint}/${encodeURIComponent(intent.intent_id)}/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify(ack),
    });
    if (!ackResponse.ok) throw new OwnerScheduleSafetyError(`schedule intent ack failed: ${ackResponse.status}`);
    const ackPayload = await ackResponse.json() as any;
    if (!ackPayload?.ok) throw new OwnerScheduleSafetyError("schedule intent ack rejected");
    if (journalCreated) {
      recordOwnerScheduleAudit(options.configPath, {
        intent_id: intent.intent_id,
        schedule_id: intent.schedule_id,
        base_revision: intent.base_revision,
        status: ack.status as "applied" | "rejected",
        ...(ack.result_revision === undefined ? {} : { result_revision: Number(ack.result_revision) }),
        ...(ack.error_code === undefined ? {} : { error_code: String(ack.error_code) }),
      });
      finalizeOwnerScheduleIntent(options.configPath, intent.intent_id);
    }
  };

  const trigger = async () => {
    if (stopped) return;
    if (!running) running = run().catch((error) => {
      log(`owner schedule control: ${errorCode(error)}`);
    }).finally(() => { running = null; });
    await running;
  };
  const timer = setInterval(() => { void trigger(); }, options.pollIntervalMs ?? 15_000);
  timer.unref();
  void trigger();
  return {
    enabled: true,
    trigger,
    stop() { stopped = true; clearInterval(timer); },
  };
}
