// #906 intent contains identifiers only. API keys remain on the owning daemon.
export type ProviderCollection = {
  node_id: string; alias: string; node_revision: string;
  provider_id: string; auth_id: string; label: string;
};
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
export function validProviderCollection(v: any): v is ProviderCollection {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).every(k => ['node_id', 'alias', 'node_revision', 'provider_id', 'auth_id', 'label'].includes(k))
    && id(v.node_id) && id(v.provider_id) && id(v.auth_id)
    && typeof v.alias === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(v.alias)
    && typeof v.node_revision === 'string' && /^[a-f0-9]{64}$/.test(v.node_revision)
    && typeof v.label === 'string' && !!v.label.trim() && v.label.length <= 100 && !/[\x00-\x1f\x7f]/.test(v.label);
}
