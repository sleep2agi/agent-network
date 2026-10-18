// #906: one managed ChatGPT sign-in ceremony in an isolated draft CODEX_HOME.
// No node switch, credential export, external-token mode or inference here.
import { EventEmitter } from 'node:events';

export interface LoginRpc {
  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  close(): Promise<void>;
}
type Status = 'idle' | 'starting' | 'awaiting_user' | 'verifying' | 'authenticated' | 'cancelled' | 'failed';
type Challenge = { loginId: string; verificationUrl: string; userCode: string };
type Completion = { loginId: string; success: boolean };
export type ManagedLoginView = { status: Status; error?: string; challenge?: Challenge };

/** Caller owns a fresh private draft home and the trusted Codex process.
 * Public state contains no account email, OAuth token or raw RPC error.
 * A successful ceremony authorizes no node change; binding is a separate action.
 */
export class CodexManagedLogin extends EventEmitter {
  private status: Status = 'idle';
  private errorCode?: string;
  private challenge?: Challenge;
  private earlyCompletion?: Completion;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly rpc: LoginRpc, private readonly deadlineMs = 600_000) {
    super();
    rpc.on('account/login/completed', this.completed);
    rpc.on('exit', this.exited);
    rpc.on('error', this.exited);
  }
  view(): ManagedLoginView {
    return { status: this.status, ...(this.errorCode ? { error: this.errorCode } : {}),
      ...(this.status === 'awaiting_user' && this.challenge ? { challenge: { ...this.challenge } } : {}) };
  }
  private transition(status: Status, error?: string) {
    this.status = status;
    this.errorCode = error;
    if (['authenticated', 'cancelled', 'failed'].includes(status)) clearTimeout(this.timer);
    this.emit('changed', this.view());
  }
  private is(status: Status): boolean { return this.status === status; }
  async start(): Promise<ManagedLoginView> {
    if (this.status !== 'idle' || this.closed) throw new Error('login_already_started');
    this.transition('starting');
    this.timer = setTimeout(() => { void this.expire(); }, this.deadlineMs);
    try {
      const current = await this.rpc.request<any>('account/read', { refreshToken: false }, 10_000);
      if (!this.is('starting')) return this.view();
      // A draft must never silently overwrite an already logged-in account.
      if (!current || current.account !== null) throw new Error('draft_not_empty');
      const result = await this.rpc.request<any>('account/login/start', { type: 'chatgptDeviceCode' }, 30_000);
      if (!result || result.type !== 'chatgptDeviceCode'
        || typeof result.loginId !== 'string' || !/^[a-f0-9-]{36}$/i.test(result.loginId)
        || result.verificationUrl !== 'https://auth.openai.com/codex/device'
        || typeof result.userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(result.userCode)) {
        throw new Error('invalid_login_challenge');
      }
      this.challenge = { loginId: result.loginId, verificationUrl: result.verificationUrl, userCode: result.userCode };
      if (!this.is('starting')) {
        // Cancel may have won while the start RPC was in flight.
        await this.cancelRemote();
        return this.view();
      }
      this.transition('awaiting_user');
      if (this.earlyCompletion) this.completed(this.earlyCompletion);
    } catch {
      if (this.is('starting')) this.transition('failed', 'login_start_failed');
    }
    return this.view();
  }
  private completed = (event: unknown) => {
    const value = event as Partial<Completion> | null;
    if (!value || typeof value.loginId !== 'string' || typeof value.success !== 'boolean') return;
    if (this.status === 'starting') {
      this.earlyCompletion = { loginId: value.loginId, success: value.success };
      return;
    }
    if (this.status !== 'awaiting_user' || value.loginId !== this.challenge?.loginId) return;
    if (!value.success) { this.transition('failed', 'login_rejected'); return; }
    this.transition('verifying');
    void this.verifyAccount();
  };
  private async verifyAccount() {
    try {
      const result = await this.rpc.request<any>('account/read', { refreshToken: false }, 10_000);
      if (this.status !== 'verifying') return;
      if (result?.account?.type !== 'chatgpt') throw new Error('account_not_chatgpt');
      this.transition('authenticated');
    } catch {
      if (this.status === 'verifying') this.transition('failed', 'account_read_failed');
    }
  }
  private exited = () => {
    if (['starting', 'awaiting_user', 'verifying'].includes(this.status)) this.transition('failed', 'login_process_exited');
  };
  private async cancelRemote() {
    if (!this.challenge) return;
    try { await this.rpc.request('account/login/cancel', { loginId: this.challenge.loginId }, 5000); } catch {}
    // The owned draft process is also closed, so failed cancellation cannot keep
    // polling indefinitely. Draft credentials never become a node's credentials.
  }
  async cancel(): Promise<ManagedLoginView> {
    if (!['starting', 'awaiting_user', 'verifying'].includes(this.status)) return this.view();
    this.transition('cancelled');
    await this.cancelRemote();
    await this.close();
    return this.view();
  }
  private async expire() {
    if (!['starting', 'awaiting_user', 'verifying'].includes(this.status)) return;
    this.transition('failed', 'login_expired');
    await this.cancelRemote();
    await this.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (['starting', 'awaiting_user', 'verifying'].includes(this.status)) {
      this.transition('cancelled');
      await this.cancelRemote();
    }
    await this.rpc.close();
    this.rpc.off('account/login/completed', this.completed);
    this.rpc.off('exit', this.exited);
    this.rpc.off('error', this.exited);
  }
}
