// #906 public application protocol. No paths, endpoints or credentials.
export type ProviderApplicationSelection = {
  node_id: string; node_revision: string; provider_id: string; auth_id: string;
  model: string; confirm_restart: true;
  account_id?: string;
};
const fields = (v: any, names: string[]) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v);
const hash = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const account = (v: any) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function validProviderApplicationSelection(v: any): v is ProviderApplicationSelection {
  return fields(v, ['node_id', 'node_revision', 'provider_id', 'auth_id', 'model', 'confirm_restart',
    ...(v?.account_id !== undefined ? ['account_id'] : [])])
    && (v.account_id === undefined || (v.provider_id === 'openai' && account(v.account_id)))
    && id(v.node_id) && hash(v.node_revision) && id(v.provider_id) && id(v.auth_id) && id(v.model)
    && v.confirm_restart === true;
}
export function validProviderApplicationReceipt(v: any, requestId: string, revision: number,
  selection: ProviderApplicationSelection): boolean {
  return fields(v, ['status', 'request_id', 'node_id', 'provider_id', 'auth_id', 'model', 'runtime_provider',
    'node_revision', 'provider_revision', 'verification', 'applied_at', ...(selection.account_id ? ['account_id'] : [])])
    && v.status === 'applied' && v.request_id === requestId && v.node_id === selection.node_id
    && v.provider_id === selection.provider_id && v.auth_id === selection.auth_id && v.model === selection.model
    && (selection.account_id ? v.runtime_provider === 'openai' && v.account_id === selection.account_id
      : typeof v.runtime_provider === 'string' && /^anet_[a-f0-9]{20}$/.test(v.runtime_provider))
    && hash(v.node_revision) && v.provider_revision === revision && v.verification === 'runtime_confirmed'
    && Number.isSafeInteger(v.applied_at) && v.applied_at > 0 && v.applied_at <= Date.now() + 30_000;
}
