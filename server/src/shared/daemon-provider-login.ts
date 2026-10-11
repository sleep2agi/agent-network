// #906 managed login transport: only explicit actions and secret-free projections.
export type LoginIntent = { action: 'start' | 'read' | 'cancel' | 'save' | 'accounts'; session_id?: string; label?: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: any, names: string[]) => Object.keys(v).every(k => names.includes(k));
export function validLoginIntent(v: any): v is LoginIntent {
  return object(v) && keys(v, ['action','session_id','label'])
    && ['start','read','cancel','save','accounts'].includes(v.action)
    && (v.action === 'accounts' ? v.session_id === undefined : typeof v.session_id === 'string' && uuid.test(v.session_id))
    && (v.action === 'save' ? typeof v.label === 'string' && !!v.label.trim() && v.label.length <= 100 && !/[\x00-\x1f\x7f]/.test(v.label) : v.label === undefined);
}
export function validLoginReceipt(v: any, intent: LoginIntent, network: string, daemon: string): boolean {
  if (!object(v)) return false;
  if (intent.action === 'accounts') return keys(v, ['accounts']) && Array.isArray(v.accounts) && v.accounts.length <= 100
    && v.accounts.every((a: any) => object(a) && keys(a, ['version','network_id','daemon_node_id','account_id','label','created_at','auth_state'])
      && a.version === 1 && a.network_id === network && a.daemon_node_id === daemon
      && typeof a.account_id === 'string' && uuid.test(a.account_id)
      && typeof a.label === 'string' && a.label.length <= 100
      && Number.isSafeInteger(a.created_at) && a.auth_state === 'not_checked');
  if (!keys(v, ['request_id','status','error','challenge','account_id']) || v.request_id !== intent.session_id
    || !['idle','starting','awaiting_user','verifying','authenticated','cancelled','failed'].includes(v.status)) return false;
  if (v.error !== undefined && !['login_start_failed','login_rejected','account_read_failed','login_process_exited','login_expired'].includes(v.error)) return false;
  if (v.account_id !== undefined && (v.status !== 'authenticated' || typeof v.account_id !== 'string' || !uuid.test(v.account_id))) return false;
  if (intent.action === 'cancel' && v.status !== 'cancelled') return false;
  if (intent.action === 'save' && (v.status !== 'authenticated' || !v.account_id)) return false;
  if (v.status === 'awaiting_user') return object(v.challenge) && keys(v.challenge, ['loginId','verificationUrl','userCode'])
    && typeof v.challenge.loginId === 'string' && uuid.test(v.challenge.loginId)
    && v.challenge.verificationUrl === 'https://auth.openai.com/codex/device'
    && typeof v.challenge.userCode === 'string' && /^[A-Z0-9-]{4,32}$/i.test(v.challenge.userCode);
  return v.challenge === undefined;
}
