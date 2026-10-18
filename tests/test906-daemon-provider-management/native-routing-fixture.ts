// TEST-ONLY HTTPS peer for an offline container with
// --add-host chatgpt.com:127.0.0.1. The native binary and product configuration
// are unchanged. This proves protocol integration, NOT real authorization.
import { readFileSync } from 'node:fs';
export function startNativeRoutingFixture() {
  let checks = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 443,
    tls: { key: readFileSync('/tmp/fixture-key.pem'), cert: readFileSync('/usr/local/share/ca-certificates/provider906.crt') },
    fetch(req) {
      if (new URL(req.url).pathname === '/backend-api/wham/accounts/check') {
        const id = req.headers.get('chatgpt-account-id');
        if (!id || !req.headers.get('authorization')?.startsWith('Bearer ')) return new Response('{}', { status: 401 });
        checks++;
        return Response.json({ accounts: [{ id, workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }] });
      }
      return new Response('{}', { status: 404 });
    },
  });
  return { stop: () => server.stop(true), checks: () => checks };
}
