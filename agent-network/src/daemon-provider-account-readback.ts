import { defaultWebSocketCtor } from './codex-copresence-rpc';
import { DaemonProviderError } from './daemon-provider-store';

/** Read only the exact owned node's loopback app-server. No logout/login or
 * token refresh request, and no account details are returned to the Hub. */
export async function verifyChatgptAppserver(endpoint: string, timeoutMs = 10_000, webSocketCtor?: any): Promise<void> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new DaemonProviderError('invalid_account_endpoint'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DaemonProviderError('invalid_account_endpoint');
  }
  const Ctor = webSocketCtor ?? await defaultWebSocketCtor(1024 * 1024);
  const socket = new Ctor(url.toString());
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { socket.close(); } catch { /* never leak raw socket errors */ }
      if (ok) resolve(); else reject(new DaemonProviderError('runtime_account_unconfirmed'));
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => finish(false));
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'anet-provider-account-check', version: '1' } } }));
    });
    let awaitingAccount = false;
    socket.addEventListener('message', (event: any) => {
      let response: any;
      try { response = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
      if (response.method) return;
      if (response.id === 1 && !awaitingAccount) {
        if (response.error && !/already initialized/i.test(String(response.error.message))) return finish(false);
        awaitingAccount = true;
        if (!response.error) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/read', params: { refreshToken: false } }));
      } else if (response.id === 2 && awaitingAccount) {
        finish(!response.error && response.result?.account?.type === 'chatgpt' && response.result.requiresOpenaiAuth === true);
      }
    });
  });
}
