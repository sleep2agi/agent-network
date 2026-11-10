// TEST-ONLY unsigned local auth cache. Accepted for local account/read parsing,
// NEVER evidence of OAuth issuance, remote authorization or model entitlement.
export function nativeAccountFixture(accountId: string, email: string) {
  const claims = { sub: 'TEST-ONLY-user', email, exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } };
  const jwt = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'), 'TEST-ONLY-unsigned'].join('.');
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: jwt, access_token: jwt, refresh_token: `TEST-ONLY-refresh-${accountId}`, account_id: accountId,
  }, last_refresh: new Date().toISOString() };
}
