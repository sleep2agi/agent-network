// New identity/epoch wire only. Real product client/Hub/Bridge/runtime adapters,
// isolated SQLite credentials and a model-free OpenCode HTTP fixture.
import assert from 'node:assert/strict';
import { createSessionBackgroundControl } from '/work/agent-node/src/runtime/opencode-copresence/session-background';
import { fetchOpenCodeSessionControlJson } from '/work/agent-node/src/runtime/opencode-copresence/http';
import { createNodeSessionControlBridge, createSessionControlPin } from '/work/agent-node/src/runtime/session-control-bridge';
import { runSessionControl } from '/work/client-src/node-session-control';

let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`PASS ${name}`); };
const { db } = await import('/work/server/src/db.js');
const { register, createNetworkTokenForNode, resolveToken } = await import('/work/server/src/auth.js');
const human = register('identity_wire_owner', 'Isolated-Identity-Wire-2014!');
assert.ok(human.ok);
const net = human.network_id!, userId = human.user.user_id;
const { bootServer } = await import('/work/server/src/server.js');
const hub = bootServer({ hostname: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const cfg = { serverUrl: base, token: human.token!, networkId: net };
const fixtures: Array<{ close(): Promise<void> }> = [];

function fixture(label: string) {
  const sid = `ses_Identity${label}`, nodeId = `n_identity${label}`;
  const node = createNetworkTokenForNode(userId, net, `identity-${label}`, nodeId);
  assert.ok(node.ok);
  const peer = createNetworkTokenForNode(userId, net, `peer-${label}`, `n_peer${label}`);
  assert.ok(peer.ok);
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status) VALUES (?1,?2,?3,?4,'working')",
    [`r_identity${label}`, `identity-${label}`, nodeId, net]);
  const initialToken = node.token!;
  let liveToken = initialToken, epoch = 0, revokeAt: 'none' | 'prewrite' | 'postwrite' = 'none';
  const lifetime = new AbortController();
  const revoke = () => { epoch++; lifetime.abort(); liveToken = peer.token!; };
  const writes: string[] = [], routes: string[] = [], claims: any[] = [], registrations: any[] = [], acknowledgements: any[] = [];
  const fixtureAuth = `Basic ${Buffer.from('opencode:isolated-identity-only').toString('base64')}`;
  const oc = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (req.headers.get('authorization') !== fixtureAuth) return new Response(null, { status: 401 });
    const path = new URL(req.url).pathname;
    if (req.method === 'POST') {
      writes.push(path);
      return new Response(null, { status: path === `/api/session/${sid}/background` ? 204 : 400 });
    }
    if (path === '/openapi.json') return Response.json({ paths: { '/api/session/{sessionID}/background': { post: { operationId: 'session.background' } } } });
    if (path === `/api/session/${sid}`) return Response.json({ data: { id: sid, location: { directory: '/identity-fixture' } } });
    if (path === '/api/session/active') return Response.json({ data: { [sid]: { type: 'running' } } });
    return new Response(null, { status: 404 });
  } });
  const session = { isRunning: true, sessionId: sid, backgroundControl: createSessionBackgroundControl({
    sessionId: sid, directory: '/identity-fixture', isCurrent: () => true,
    request: async (path, init) => {
      const value = await fetchOpenCodeSessionControlJson(`http://127.0.0.1:${oc.port}`, 'isolated-identity-only', path, init);
      // Revoke only AFTER a real HTTP read/write completed, not a mocked result.
      if ((revokeAt === 'prewrite' && path === '/api/session/active')
        || (revokeAt === 'postwrite' && init?.method === 'POST')) { revokeAt = 'none'; revoke(); }
      return value;
    },
  }) };
  const makeBridge = (token: string) => createNodeSessionControlBridge({ session: () => session, warn: () => {},
    identity: createSessionControlPin({ hubUrl: base, token, nodeId, networkId: net, epoch,
      currentToken: () => token === initialToken ? liveToken : token, currentEpoch: () => epoch,
      signal: token === initialToken ? lifetime.signal : new AbortController().signal,
      fetch: (async (url, init) => {
        const path = new URL(String(url)).pathname; routes.push(path);
        const response = await fetch(url, init);
        const value = await response.clone().json();
        if (path.endsWith('/bridge')) registrations.push({ status: response.status, value });
        if (path.endsWith('/pull') && value.request) claims.push(value.request);
        if (path.endsWith('/ack')) acknowledgements.push({ status: response.status, value });
        return response;
      }) as typeof fetch,
    }),
  });
  const bridge = makeBridge(initialToken);
  const timer = setInterval(() => { void bridge.trigger(); }, 10);
  const f = { sid, nodeId, session, bridge, target: { node_id: nodeId, network_id: net, session_id: sid },
    writes, routes, claims, registrations, acknowledgements, makeWrongBridge: () => makeBridge(peer.token!),
    expectedTokenId: resolveToken(initialToken)!.tokenId,
    arm: (when: 'prewrite' | 'postwrite') => { revokeAt = when; },
    restoreToken: () => { liveToken = initialToken; epoch++; },
    async close() { clearInterval(timer); await bridge.trigger(); oc.stop(true); },
  };
  fixtures.push(f); return f;
}

async function state(f: ReturnType<typeof fixture>) {
  const r = await runSessionControl(cfg, f.target, undefined, { waitMs: 3_000 });
  assert.ok(r.ok); return r.state;
}

try {
  const positive = fixture('Positive');
  check('new wire: actual Bridge registers with actual Hub', await positive.bridge.register());
  const proof = positive.registrations[0].value.identity;
  check('new wire: all three authority fields match authenticated token identity', proof.node_id === positive.nodeId
    && proof.network_id === net && proof.token_id === positive.expectedTokenId);
  const initial = await state(positive);
  const result = await runSessionControl(cfg, positive.target, initial, { waitMs: 3_000 });
  check('new wire: unchanged client receives request_processed, never backgrounded', result.ok && result.outcome === 'request_processed');
  check('new wire: exactly one original-session POST through all product layers', positive.writes.length === 1
    && positive.writes[0] === `/api/session/${positive.sid}/background`);
  const bindingBefore = initial.binding_id;
  const beforeClaims = positive.claims.length;
  const beforeWrites = positive.writes.length;
  const wrong = positive.makeWrongBridge();
  check('wrong authority: actual Hub rejects correct wire under a different node token', !await wrong.register());
  const rejected = positive.registrations.at(-1);
  check('wrong authority: real 409 not a fake success identity', rejected.status === 409
    && rejected.value.error === 'session_control_changed' && rejected.value.identity === undefined);
  const beforeWrongTrigger = positive.routes.length;
  await wrong.trigger();
  check('wrong authority: rejected Bridge never pulls or writes', positive.routes.length === beforeWrongTrigger
    && positive.claims.length === beforeClaims && positive.writes.length === beforeWrites);
  check('wrong authority: original binding stays usable and was not retired', (await state(positive)).binding_id === bindingBefore);

  for (const mode of ['prewrite', 'postwrite'] as const) {
    const f = fixture(mode);
    check(`${mode}: new isolated Bridge registers`, await f.bridge.register());
    const current = await state(f);
    const beforeAcks = f.acknowledgements.length;
    f.arm(mode);
    const pending = await runSessionControl(cfg, f.target, current, { waitMs: 1_100 });
    check(`${mode}: no success receipt after local authority revocation`, !pending.ok && pending.error === 'unknown');
    check(`${mode}: exactly one claim of the new background request`, f.claims.filter(c => c.operation === 'background').length === 1);
    check(`${mode}: no ACK sent under revoked authority`, f.acknowledgements.length === beforeAcks);
    check(`${mode}: runtime writes match the cancellation boundary`, f.writes.length === (mode === 'prewrite' ? 0 : 1)
      && f.writes.every(p => p === `/api/session/${f.sid}/background`));
    const beforeABA = f.routes.length;
    f.restoreToken();
    check(`${mode}: A-to-B-to-A never revives the old pin`, !await f.bridge.register());
    await f.bridge.trigger(); await f.bridge.trigger();
    check(`${mode}: no network claim/ACK/replay after ABA`, f.routes.length === beforeABA
      && f.writes.length === (mode === 'prewrite' ? 0 : 1));
  }
  console.log(`RESULT PASS ${passed} new-identity-wire assertions; not the old 13-case suite, not a real CLI/TUI or node activation`);
} finally {
  for (const f of fixtures) await f.close();
  hub.stop(true);
}
process.exit(0);
