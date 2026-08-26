import type { SideThreadCommandAck, SideThreadTerminalEnvelope } from "./command-transport";
import { SideThreadCommandExecutor } from "./command-transport";
import type { PrivateFileTerminalOutbox } from "./terminal-outbox";

/** Polls only the dedicated SideThread outbox. It has no task handler seam. */
export class SideThreadCommandConsumer {
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly endpoint: string;
  constructor(private readonly opts: {
    hubUrl: string; nodeId: string; token: string | (() => string);
    executor: SideThreadCommandExecutor; terminalOutbox: PrivateFileTerminalOutbox; fetchImpl?: typeof fetch;
  }) {
    if (!safe(opts.nodeId) || !opts.hubUrl) throw new Error("invalid SideThread consumer identity");
    this.endpoint = `${opts.hubUrl.replace(/\/+$/, "")}/api/nodes/${encodeURIComponent(opts.nodeId)}/side-thread-commands`;
  }
  async trigger(): Promise<void> {
    if (this.stopped) return;
    if (!this.running) this.running = this.consumeOnce().finally(() => { this.running = null; });
    await this.running;
  }
  stop(): void { this.stopped = true; }
  async sendTerminal(envelope: SideThreadTerminalEnvelope): Promise<void> {
    this.opts.terminalOutbox.enqueue(envelope);
    await this.drainTerminals();
  }
  private async consumeOnce(): Promise<void> {
    await this.drainTerminals();
    const response = await this.fetch(`${this.endpoint}/pending`, { headers: this.headers() });
    if (!response.ok) throw new Error(`SideThread command pull failed: ${response.status}`);
    const payload = await response.json() as any;
    if (!payload?.ok || payload.command == null) return;
    if (payload.command.nodeId !== this.opts.nodeId) throw new Error("SideThread command node ownership mismatch");
    const ack: SideThreadCommandAck = await this.opts.executor.execute(payload.command);
    const ackResponse = await this.fetch(`${this.endpoint}/${encodeURIComponent(ack.commandId)}/ack`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(ack),
    });
    if (!ackResponse.ok || !(await ackResponse.json() as any)?.ok) throw new Error(`SideThread command ACK failed: ${ackResponse.status}`);
  }
  private async drainTerminals(): Promise<void> {
    for (const envelope of this.opts.terminalOutbox.list()) {
      const response = await this.fetch(`${this.endpoint}/terminals`, { method: "POST", headers: this.headers(), body: JSON.stringify(envelope) });
      if (!response.ok || !(await response.json() as any)?.ok) throw new Error(`SideThread terminal POST failed: ${response.status}`);
      this.opts.terminalOutbox.remove(envelope);
    }
  }
  private headers(): Record<string, string> {
    const token = typeof this.opts.token === "function" ? this.opts.token() : this.opts.token;
    if (!token.startsWith("ntok_")) throw new Error("bound node token required");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }
  private fetch(input: string, init?: RequestInit) { return (this.opts.fetchImpl ?? fetch)(input, init); }
}
function safe(v: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v); }
