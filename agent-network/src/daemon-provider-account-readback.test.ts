import { expect, test } from 'bun:test';
import { verifyChatgptAppserver } from './daemon-provider-account-readback';

test('account readback uses initialized actual socket and rejects wrong or absent auth', async () => {
  for (const type of ['chatgpt', 'apiKey', null]) {
    const calls: string[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch(req, server) { return server.upgrade(req) ? undefined : new Response('bad', { status: 400 }); },
      websocket: { message(ws, message) {
        const m = JSON.parse(String(message)); calls.push(m.method);
        if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
        if (m.method === 'account/read') {
          expect(m.params).toEqual({ refreshToken: false });
          ws.send(JSON.stringify({ id: m.id, result: { requiresOpenaiAuth: true, account: type ? { type } : null } }));
        }
      } },
    });
    try {
      const run = verifyChatgptAppserver(`ws://127.0.0.1:${server.port}`, 1000);
      if (type === 'chatgpt') await run; else await expect(run).rejects.toThrow('runtime_account_unconfirmed');
      expect(calls).toEqual(['initialize', 'initialized', 'account/read']);
    } finally { server.stop(true); }
  }
});

test('account readback refuses remote endpoints and bounds an unresponsive socket', async () => {
  await expect(verifyChatgptAppserver('ws://example.test:9000')).rejects.toThrow('invalid_account_endpoint');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response('bad'); }, websocket: { message() {} } });
  try { await expect(verifyChatgptAppserver(`ws://127.0.0.1:${server.port}`, 30)).rejects.toThrow('runtime_account_unconfirmed'); }
  finally { server.stop(true); }
});
