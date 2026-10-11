// One instance per registered daemon. Only public projections may cross Hub RPC.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexLoginDraft } from './codex-login-draft';
import type { ManagedLoginView } from './codex-managed-login';

type Draft = Awaited<ReturnType<typeof createCodexLoginDraft>>;
type Scope = { network_id: string; daemon_node_id: string };
type Account = Scope & { version: 1; account_id: string; label: string; created_at: number };
export type DaemonLoginView = ManagedLoginView & { request_id: string; account_id?: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const recordName = 'anet-account.json';

/** root is fixed by daemon boot, never a path in a remote request. Saving retains
 * this ceremony's CODEX_HOME in place; it never copies another node's auth.json.
 * Saved records describe accounts, not their current validity or node bindings.
 */
export class DaemonCodexLogins {
  private current?: { id: string; draft: Draft; account?: Account };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly scope: Scope,
    private readonly factory: () => Promise<Draft> = () => createCodexLoginDraft(root)) {
    if (!scope.network_id || !scope.daemon_node_id) throw new Error('login_scope_required');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  private entry(id: string) {
    if (!uuid.test(id) || this.current?.id !== id) throw new Error('login_not_found');
    return this.current;
  }
  private view(): DaemonLoginView {
    const entry = this.current!;
    return { request_id: entry.id, ...entry.draft.login.view(),
      ...(entry.account ? { account_id: entry.account.account_id } : {}) };
  }
  start(requestId: string): Promise<DaemonLoginView> {
    return this.serial(async () => {
      if (!uuid.test(requestId)) throw new Error('invalid_login_request');
      if (this.current?.id === requestId) return this.view();
      if (this.current) {
        const state = this.current.draft.login.view().status;
        if (!this.current.account && !['failed', 'cancelled'].includes(state)) throw new Error('login_in_progress');
        if (!this.current.account) await this.current.draft.discard();
      }
      let draft: Draft;
      try { draft = await this.factory(); }
      catch { throw new Error('login_process_start_failed'); }
      this.current = { id: requestId, draft };
      await draft.login.start();
      if (['failed', 'cancelled'].includes(draft.login.view().status)) await draft.discard();
      return this.view();
    });
  }
  read(requestId: string): Promise<DaemonLoginView> {
    return this.serial(async () => {
      const entry = this.entry(requestId);
      if (['failed', 'cancelled'].includes(entry.draft.login.view().status)) await entry.draft.discard();
      return this.view();
    });
  }
  cancel(requestId: string): Promise<DaemonLoginView> {
    return this.serial(async () => {
      const entry = this.entry(requestId);
      if (entry.account) throw new Error('account_already_saved');
      await entry.draft.login.cancel();
      // A user may discard a successful but not-yet-saved ceremony too.
      await entry.draft.discard();
      this.current = undefined;
      return { request_id: requestId, status: 'cancelled' };
    });
  }
  save(requestId: string, label: string): Promise<DaemonLoginView> {
    return this.serial(async () => {
      const entry = this.entry(requestId);
      if (entry.account) return this.view(); // retry after lost response
      if (entry.draft.login.view().status !== 'authenticated') throw new Error('login_not_authenticated');
      if (typeof label !== 'string' || !label.trim() || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) {
        throw new Error('invalid_account_label');
      }
      await entry.draft.login.close();
      try {
        const auth = lstatSync(join(entry.draft.home, 'auth.json'));
        if (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1
          || (process.getuid && auth.uid !== process.getuid())
          || (process.platform !== 'win32' && (auth.mode & 0o077))) throw new Error('private_auth_required');
        const account: Account = { version: 1, ...this.scope, account_id: randomUUID(),
          label: label.trim(), created_at: Date.now() };
        // Exclusive marker: a draft cannot silently replace a saved identity.
        const record = join(entry.draft.home, recordName);
        const fd = openSync(record, 'wx', 0o600);
        let written = false;
        try { writeFileSync(fd, JSON.stringify(account) + '\n'); fsyncSync(fd); written = true; }
        finally { closeSync(fd); if (!written) rmSync(record, { force: true }); }
        entry.account = account;
      } catch { throw new Error('account_save_failed'); }
      return this.view();
    });
  }
  listSaved(): Array<Account & { auth_state: 'not_checked' }> {
    const accounts: Array<Account & { auth_state: 'not_checked' }> = [];
    for (const child of readdirSync(this.root, { withFileTypes: true })) {
      if (!child.isDirectory() || !/^login-[A-Za-z0-9]+$/.test(child.name)) continue;
      try {
        const file = join(this.root, child.name, recordName);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value.version !== 1 || value.network_id !== this.scope.network_id
          || value.daemon_node_id !== this.scope.daemon_node_id || !uuid.test(value.account_id)
          || typeof value.label !== 'string' || value.label.length > 100
          || !Number.isSafeInteger(value.created_at)) continue;
        accounts.push({ version: 1, ...this.scope, account_id: value.account_id,
          label: value.label, created_at: value.created_at, auth_state: 'not_checked' });
      } catch { /* An interrupted unsaved draft is not an account. */ }
    }
    return accounts.sort((a, b) => a.created_at - b.created_at);
  }
  close(): Promise<void> {
    return this.serial(async () => {
      if (this.current) {
        if (this.current.account) await this.current.draft.login.close();
        else await this.current.draft.discard();
      }
      this.current = undefined;
    });
  }
}
