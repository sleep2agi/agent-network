import { createHash } from "node:crypto";
import type { OwnedFollowUpReceiptEntry, PersistedTurnResult } from "./receipt-ledger";
import type { FollowUpHubState } from "./followup-hub-check";

export interface OwnedFollowUpAdapter {
  prepare(input: { taskId: string; text: string; from?: string; threadId: string; ownerTaskId: string; ownerTurnId: string }): OwnedFollowUpReceiptEntry | undefined;
  accept(entry: OwnedFollowUpReceiptEntry): OwnedFollowUpReceiptEntry;
  prepareAnswer(entry: OwnedFollowUpReceiptEntry): OwnedFollowUpReceiptEntry;
  bindAnswer(entry: OwnedFollowUpReceiptEntry, turnId: string): OwnedFollowUpReceiptEntry;
  status(entry: OwnedFollowUpReceiptEntry): Promise<FollowUpHubState>;
  terminal(entry: OwnedFollowUpReceiptEntry): void;
}
export interface OwnedFollowUpHost {
  threadId(): string;
  steer(entry: OwnedFollowUpReceiptEntry, text: string): Promise<void>;
  acceptance(entry: OwnedFollowUpReceiptEntry): Promise<boolean>;
  findAnswer(entry: OwnedFollowUpReceiptEntry): Promise<string | null>;
  inspect(threadId: string, turnId: string, clientId: string): Promise<PersistedTurnResult>;
  enqueueAnswer(entry: OwnedFollowUpReceiptEntry, text: string): void;
  adoptAnswer(entry: OwnedFollowUpReceiptEntry): void;
  emit(name: string, event: Record<string, unknown>): void;
}
type LiveFollowUp = { entry: OwnedFollowUpReceiptEntry; busy: boolean; ownerDone: boolean; answerQueued: boolean; admission?: Promise<void> };

export const followUpInputHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function followUpMarker(entry: OwnedFollowUpReceiptEntry): string {
  return "[ANetFollowUp " + JSON.stringify({ task: entry.taskId, ownerTask: entry.ownerTaskId,
    ownerTurn: entry.ownerTurnId, nonce: entry.nonce, inputSha256: entry.inputSha256 }) + "]\n";
}
export function followUpInput(entry: OwnedFollowUpReceiptEntry, text: string): string {
  return `[Agent Network/task=${entry.taskId}] This is an independently replyable follow-up to task ${entry.ownerTaskId}. ` +
    `Use this follow-up's own task ID for any explicit Hub reply. The owner's final answer does not answer this task.\n` + followUpMarker(entry) + text;
}
export function provesFollowUpInput(entry: OwnedFollowUpReceiptEntry, item: unknown): boolean {
  if (!item || typeof item !== "object" || (item as any).type !== "userMessage") return false;
  const row = item as { text?: unknown; content?: Array<{ type?: string; text?: unknown }> };
  const texts = [row.text, ...(Array.isArray(row.content) ? row.content.filter(x => x.type === "text").map(x => x.text) : [])];
  const marker = followUpMarker(entry);
  return texts.some(text => {
    if (typeof text !== "string") return false;
    const index = text.indexOf(marker);
    return index >= 0 && followUpInputHash(text.slice(index + marker.length)) === entry.inputSha256;
  });
}
export function followUpAnswerPrompt(entry: OwnedFollowUpReceiptEntry): string {
  return `Answer only Agent Network task ${entry.taskId}, previously injected into task ${entry.ownerTaskId} / turn ${entry.ownerTurnId}. ` +
    "Its action input was already submitted. Do not repeat actions, commands, edits, delegation, publication or other tools. " +
    "Use existing conversation results to give this task its own concise final answer. If completion is unknown or the original turn failed, state that explicitly. " +
    "Do not copy the owner's final answer as proof that this follow-up succeeded. Do not change thread, model, login or provider.";
}

/** Independent reply ownership. No shared owner final text enters this controller. */
export class OwnedFollowUpController {
  private rows = new Map<string, LiveFollowUp>();
  private reconciliation: Promise<void> | null = null;
  constructor(private readonly adapter: OwnedFollowUpAdapter, private readonly host: OwnedFollowUpHost) {}
  has(taskId: string) { return this.rows.has(taskId); }
  isAnswer(taskId: string) { const row = this.rows.get(taskId); return row?.answerQueued === true || row?.entry.phase === "answer_intent" || row?.entry.phase === "answering"; }
  answerSubmitted(taskId: string) { const phase = this.rows.get(taskId)?.entry.phase; return phase === "answer_intent" || phase === "answering"; }
  onOwner(turnId: string) { return [...this.rows.values()].some(row => row.entry.ownerTurnId === turnId); }

  async admit(input: { taskId: string; text: string; from?: string }, owner: { taskId: string; turnId: string }): Promise<boolean> {
    if (this.rows.has(input.taskId)) throw Object.assign(new Error("follow-up already active"), { code: "codex_task_skipped" });
    const entry = this.adapter.prepare({ ...input, threadId: this.host.threadId(), ownerTaskId: owner.taskId, ownerTurnId: owner.turnId });
    if (!entry) return false;
    const row: LiveFollowUp = { entry, busy: true, ownerDone: false, answerQueued: false };
    let admissionDone!: () => void;
    row.admission = new Promise<void>(resolve => { admissionDone = resolve; });
    this.rows.set(entry.taskId, row);
    try {
      await this.host.steer(entry, followUpInput(entry, input.text));
      row.entry = this.adapter.accept(entry);
      this.started(row);
    } catch (error) {
      // Lost/failed transport is NOT proof of rejection. Retain intent; never
      // enqueue the original action as an ordinary retry or start another turn.
      this.host.emit("owned_followup_uncertain", { taskId: entry.taskId, ownerTurnId: entry.ownerTurnId,
        error: error instanceof Error ? error.message : String(error) });
    } finally { row.busy = false; admissionDone(); }
    void this.reconcile();
    return true;
  }

  async resume(entry: OwnedFollowUpReceiptEntry): Promise<void> {
    if (entry.threadId !== this.host.threadId()) throw new Error("follow-up receipt belongs to another thread; preserve it");
    if (this.rows.has(entry.taskId)) throw Object.assign(new Error("follow-up already active"), { code: "codex_task_skipped" });
    this.rows.set(entry.taskId, { entry, busy: false, ownerDone: false, answerQueued: false });
    // Resumption observes existing input identity; it never resubmits its body.
    if (entry.phase !== "intent") this.started(this.rows.get(entry.taskId)!);
    await this.reconcile();
  }
  async ownerFinished(ownerTaskId: string, ownerTurnId: string): Promise<void> {
    for (const row of this.rows.values()) if (row.entry.ownerTaskId === ownerTaskId && row.entry.ownerTurnId === ownerTurnId) row.ownerDone = true;
    await Promise.all([...this.rows.values()].filter(row => row.entry.ownerTurnId === ownerTurnId).map(row => row.admission));
    await this.reconcile();
  }
  forget(taskId: string): boolean { return this.rows.delete(taskId); }
  bindAnswer(taskId: string, turnId: string): void {
    const row = this.rows.get(taskId);
    if (!row || !["answer_intent", "answering"].includes(row.entry.phase)) throw new Error("answer turn has no admitted follow-up submission");
    row.entry = this.adapter.bindAnswer(row.entry, turnId);
    row.answerQueued = false;
  }
  beginAnswer(taskId: string): void {
    const row = this.rows.get(taskId);
    if (!row || !row.answerQueued || row.entry.phase !== "accepted") throw new Error("answer already submitted or no longer admitted");
    row.entry = this.adapter.prepareAnswer(row.entry);
    row.answerQueued = false;
  }
  async beforeAnswer(taskId: string): Promise<void> {
    const row = this.rows.get(taskId);
    if (!row || !row.answerQueued) throw Object.assign(new Error("follow-up no longer waiting for answer"), { code: "codex_task_skipped" });
    const status = await this.adapter.status(row.entry);
    if (this.rows.get(taskId) !== row) throw Object.assign(new Error("follow-up detached"), { code: "codex_task_skipped" });
    if (status === "terminal") {
      this.settleTerminal(row);
      throw Object.assign(new Error("follow-up terminal on Hub"), { code: "codex_task_skipped" });
    }
    if (status !== "pending") throw new Error("follow-up Hub state unknown; answer retained for retry");
  }
  private started(row: LiveFollowUp) {
    this.host.emit("task_runtime_submitted", { taskId: row.entry.taskId, turnId: row.entry.ownerTurnId, ownedFollowUp: true, steered: true });
    this.host.emit("task_started", { taskId: row.entry.taskId, turnId: row.entry.ownerTurnId, ownedFollowUp: true, steered: true });
  }
  private settleTerminal(row: LiveFollowUp) {
    this.adapter.terminal(row.entry);
    this.rows.delete(row.entry.taskId);
    this.host.emit("task_skipped", { taskId: row.entry.taskId, reason: "follow-up-terminal-on-hub" });
  }
  acceptedOn(ownerTurnId: string): string[] {
    return [...this.rows.values()].filter(row => row.entry.ownerTurnId === ownerTurnId && row.entry.phase === "accepted").map(row => row.entry.taskId);
  }
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = (async () => {
      for (const row of [...this.rows.values()]) {
        if (row.busy || this.rows.get(row.entry.taskId) !== row) continue;
        try {
          if (row.entry.phase === "intent") {
            if (!await this.host.acceptance(row.entry)) continue;
            if (this.rows.get(row.entry.taskId) !== row) continue;
            row.entry = this.adapter.accept(row.entry);
            this.started(row);
          }
          const status = await this.adapter.status(row.entry);
          if (this.rows.get(row.entry.taskId) !== row) continue;
          if (status === "terminal") { this.settleTerminal(row); continue; }
          if (status !== "pending") continue;
          if (row.entry.phase === "answer_intent") {
            const turnId = await this.host.findAnswer(row.entry);
            if (!turnId || this.rows.get(row.entry.taskId) !== row) continue;
            this.bindAnswer(row.entry.taskId, turnId);
          }
          if (row.entry.phase === "answering") {
            const answer = await this.host.inspect(row.entry.threadId, row.entry.turnId, `anet:${row.entry.taskId}`);
            if (this.rows.get(row.entry.taskId) !== row) continue;
            if (answer.state === "running") this.host.adoptAnswer(row.entry);
            else if (["completed", "failed", "interrupted"].includes(answer.state) && "replyIdentityConfirmed" in answer && answer.replyIdentityConfirmed === true) {
              if (answer.state === "completed" && answer.text?.trim()) this.host.emit("task_reply", { taskId: row.entry.taskId, text: answer.text });
              else if (answer.state === "failed" || answer.state === "interrupted") this.host.emit("task_error", { taskId: row.entry.taskId, error: answer.error || "independent answer turn failed" });
            }
            continue;
          }
          if (!row.ownerDone) {
            const owner = await this.host.inspect(row.entry.threadId, row.entry.ownerTurnId, `anet:${row.entry.ownerTaskId}`);
            row.ownerDone = row.ownerDone || (["completed", "failed", "interrupted"].includes(owner.state) && "replyIdentityConfirmed" in owner && owner.replyIdentityConfirmed === true);
          }
          if (row.ownerDone && !row.answerQueued && this.rows.get(row.entry.taskId) === row) {
            row.answerQueued = true;
            this.host.enqueueAnswer(row.entry, followUpAnswerPrompt(row.entry));
          }
        } catch (error) {
          this.host.emit("owned_followup_uncertain", { taskId: row.entry.taskId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })().finally(() => { this.reconciliation = null; });
    return this.reconciliation;
  }
}
