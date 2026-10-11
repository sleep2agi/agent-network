// Local credential custody only. The caller holds the daemon store + node locks
// and has stopped the exact node before prepare/install/rollback. No Hub payload
// can name a path, and a saved refresh chain is never lent to a second node.
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DaemonProviderError, DaemonProviderStore, readPrivateJson } from './daemon-provider-store';
import { atomicWritePrivateFile, atomicWritePrivateJson } from './private-state';

function fail(code: string): never { throw new DaemonProviderError(code); }
export function chatgptCredentialFingerprint(raw: string): string {
  let auth: any;
  try { auth = JSON.parse(raw); } catch { fail('saved_account_invalid'); }
  const token = auth?.tokens;
  if (auth?.auth_mode !== 'chatgpt' || typeof token?.account_id !== 'string' || !token.account_id
    || token.account_id.length > 200 || typeof token.access_token !== 'string' || !token.access_token
    || typeof token.refresh_token !== 'string' || !token.refresh_token) fail('saved_account_invalid');
  return createHash('sha256').update(token.account_id).digest('hex');
}
type Account = { id: string; home: string; record: Record<string, any>; fingerprint: string };
export class ProviderAccountCustody {
  private previous?: Account;
  private selected?: Account;
  private before: string | null = null;
  private next: string | null = null;
  private installed = false;
  private prepared = false;
  constructor(store: DaemonProviderStore, private nodeId: string, private authPath: string,
    previousId: string | undefined, selectedId: string | undefined,
    private readAuth: () => string | null) {
    const resolve = (id: string): Account => {
      const home = store.savedAccountHome(id);
      if (!home) fail('saved_account_unavailable');
      const record = readPrivateJson(join(home, 'anet-account.json')) as Record<string, any>;
      if (record.bound_node_id !== undefined && record.bound_node_id !== nodeId) fail('saved_account_bound_to_other_node');
      const fingerprint = chatgptCredentialFingerprint(JSON.stringify(readPrivateJson(join(home, 'auth.json'))));
      return { id, home, record, fingerprint };
    };
    if (previousId) {
      this.previous = resolve(previousId);
      if (this.previous.record.bound_node_id !== nodeId || this.previous.record.active !== true) fail('account_custody_conflict');
    }
    if (selectedId) {
      this.selected = selectedId === previousId ? this.previous : resolve(selectedId);
      // A crash or an out-of-band config edit must not revive a stale vault copy.
      if (selectedId !== previousId && this.selected?.record.active === true) fail('account_custody_conflict');
    }
  }
  get fingerprint() { return this.selected?.fingerprint; }
  get previousFingerprint() { return this.previous?.fingerprint; }
  get accountId() { return this.selected?.id; }
  /** Capture AFTER verified stop: Codex may have refreshed auth since preflight. */
  prepare() {
    this.before = this.readAuth();
    if (this.previous && (!this.before || chatgptCredentialFingerprint(this.before) !== this.previous.fingerprint)) fail('account_custody_conflict');
    this.next = this.selected
      ? this.selected === this.previous ? this.before : JSON.stringify(readPrivateJson(join(this.selected.home, 'auth.json'))) + '\n'
      : this.before;
    if (this.selected && (!this.next || chatgptCredentialFingerprint(this.next) !== this.selected.fingerprint)) fail('account_custody_conflict');
    this.prepared = true;
    return { previous_id: this.previous?.id ?? null, selected_id: this.selected?.id ?? null, before_auth: this.before };
  }
  private park(account: Account, raw: string) {
    if (chatgptCredentialFingerprint(raw) !== account.fingerprint) fail('account_custody_conflict');
    atomicWritePrivateFile(join(account.home, 'auth.json'), raw);
    account.record = { ...account.record, bound_node_id: this.nodeId, active: false };
    atomicWritePrivateJson(join(account.home, 'anet-account.json'), account.record);
  }
  install() {
    if (!this.prepared) fail('account_custody_not_prepared');
    if (this.previous && this.previous !== this.selected) this.park(this.previous, this.before!);
    if (this.selected) {
      this.selected.record = { ...this.selected.record, bound_node_id: this.nodeId, active: true };
      atomicWritePrivateJson(join(this.selected.home, 'anet-account.json'), this.selected.record);
      atomicWritePrivateFile(this.authPath, this.next!);
      this.installed = true;
    }
  }
  /** No saved copy is used for an active account. Preserve refreshed credentials
   * before restoring the old login, including a failed same-account model edit. */
  rollback() {
    if (!this.prepared) return;
    let restore = this.before;
    if (this.selected && this.installed) {
      const current = this.readAuth();
      if (!current) fail('account_custody_conflict');
      this.park(this.selected, current);
      if (this.selected === this.previous) restore = current;
    } else if (this.selected) {
      this.selected.record = { ...this.selected.record, active: false };
      atomicWritePrivateJson(join(this.selected.home, 'anet-account.json'), this.selected.record);
    }
    if (this.selected) {
      if (restore === null) { if (existsSync(this.authPath)) unlinkSync(this.authPath); }
      else atomicWritePrivateFile(this.authPath, restore);
    }
    if (this.previous) {
      this.previous.record = { ...this.previous.record, bound_node_id: this.nodeId, active: true };
      atomicWritePrivateJson(join(this.previous.home, 'anet-account.json'), this.previous.record);
    }
  }
}
