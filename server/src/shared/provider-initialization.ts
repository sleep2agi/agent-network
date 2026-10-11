export type ProviderInitialization = { revision: number; provider_id: string; auth_id: string; model: string };
export function validProviderInitialization(value: any): value is ProviderInitialization {
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['revision', 'provider_id', 'auth_id', 'model'].includes(key))
    && Number.isSafeInteger(value.revision) && value.revision >= 0 && id(value.provider_id) && id(value.auth_id)
    && typeof value.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.model);
}
