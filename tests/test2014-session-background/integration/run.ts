// Exact product client adapter -> real Hub HTTP/auth/DB/SSE -> product Bridge ->
// product runtime HTTP adapter -> synthetic OpenCode endpoint. No real model/TUI.
import assert from 'node:assert/strict';
import { createSessionBackgroundControl } from '/work/agent-node/src/runtime/opencode-copresence/session-background';
import { fetchOpenCodeJson } from '/work/agent-node/src/runtime/opencode-copresence/http';
import { createNodeSessionControlBridge } from '/work/agent-node/src/runtime/session-control-bridge';
import { runSessionControl } from '/work/client-src/node-session-control';

let passed = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`PASS ${name}`); };
const sid = 'ses_Integrated2014', peerSid = 'ses_Peer2014', nodeId = 'n_integrated2014';
let active = true, supported = true, loseAck = false;
const writes: string[] = [], events: unknown[] = [];
let bridge: ReturnType<typeof createNodeSessionControlBridge>;
const fixtureAuth = `Basic ${Buffer.from('opencode:fixture-only').toString('base64')}`;
const oc = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  if (req.headers.get('authorization') !== fixtureAuth) return new Response(null, { status: 401 });
  const path = new URL(req.url).pathname;
  if (path === '/openapi.json') return Response.json({ paths: supported ? { '/api/session/{sessionID}/background': { post: { operationId: 'session.background' } } } : {} });
  if (path === `/api/session/${sid}`) return Response.json({ data: { id: sid, location: { directory: '/fixture' } } });
  if (path === '/api/session/active') return Response.json({ data: { ...(active ? { [sid]: { type: 'running' } } : {}), [peerSid]: { type: 'running' } } });
  if (req.method === 'POST') {
    writes.push(path);
    return path === `/api/session/${sid}/background` ? new Response(null, { status: 204 }) : new Response(null, { status: 400 });
  }
  return new Response(null, { status: 404 });
} });
const { db } = await import('/work/server/src/db.js');
const { register, createNetworkTokenForNode } = await import('/work/server/src/auth.js');
const human = register('integration_owner', 'Integration-Fixture-2014!');
check('isolated human credential', human.ok);
const net = human.network_id!, token = human.token!, userId = human.user.user_id;
const node = createNetworkTokenForNode(userId, net, 'integration-target', nodeId);
check('isolated exact node token', node.ok);
db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status) VALUES (?1,?2,?3,?4,'working')", ['r_integrated2014', 'integration-target', nodeId, net]);
const { bootServer } = await import('/work/server/src/server.js');
const hub = bootServer({ hostname: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${hub.port}`;
const makeSession = () => ({ isRunning: true, sessionId: sid, backgroundControl: createSessionBackgroundControl({
  sessionId: sid, directory: '/fixture', isCurrent: () => true,
  request: (path, init) => fetchOpenCodeJson(`http://127.0.0.1:${oc.port}`, 'fixture-only', path, init),
}) });
let session = makeSession();
let unknownStarted: (() => void) | undefined;
bridge = createNodeSessionControlBridge({ session: () => session, warn: () => {},
  post: async (path, body) => {
    if (loseAck && path.endsWith('/ack')) { loseAck = false; unknownStarted?.(); throw Error('fixture dropped ACK before delivery'); }
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  },
});
const stop = new AbortController();
let readEvents: Promise<void> | undefined;
try {
  check('Bridge registers immutable original handle in real Hub', await bridge.register());
  const response = await fetch(`${base}/events/integration-target`, { headers: { authorization: `Bearer ${node.token}` }, signal: stop.signal });
  check('scoped node SSE stream opens', response.status === 200);
  const reader = response.body!.getReader();
  readEvents = (async () => {
    let buffer = '';
    try {
      while (!stop.signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += new TextDecoder().decode(chunk.value);
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'session_control') { events.push(event); void bridge.trigger(); }
        }
      }
    } catch { if (!stop.signal.aborted) throw Error('unexpected SSE failure'); }
  })();
  const cfg = { serverUrl: base, token, networkId: net };
  const target = { node_id: nodeId, network_id: net, session_id: sid };
  const state = await runSessionControl(cfg, target);
  check('unmodified client adapter reads authoritative runtime state through SSE/REST', state.ok && state.state.active && state.state.supported);
  assert.ok(state.ok);
  const result = await runSessionControl(cfg, target, state.state);
  check('204 crosses all real product layers only as request_processed', result.ok && result.outcome === 'request_processed');
  check('only one original-session write, never peer/prompt/keys', writes.length === 1 && writes[0] === `/api/session/${sid}/background`);
  const changed = await runSessionControl(cfg, target, { ...state.state, binding_id: 'incorrect-generation' });
  check('Hub HTTP409 binding refusal survives actual client transport', !changed.ok && changed.error === 'changed' && writes.length === 1);
  active = false;
  const idle = await runSessionControl(cfg, target, state.state);
  check('runtime idle no-op survives exact wire and peer stays untouched', idle.ok && idle.outcome === 'already_idle' && !idle.state.active && writes.length === 1);
  active = true; supported = false;
  const unsupported = await runSessionControl(cfg, target);
  check('missing actual API capability disables runtime state, busy peer proves nothing', unsupported.ok && !unsupported.state.supported && !unsupported.state.can_request_background);
  supported = true; loseAck = true;
  const dropped = new Promise<void>(resolve => { unknownStarted = resolve; });
  const pending = runSessionControl(cfg, target, state.state);
  await dropped;
  session = makeSession();
  await bridge.register();
  const unknown = await pending;
  check('lost ACK plus generation change is unknown to client, not fake success', !unknown.ok && unknown.error === 'unknown');
  await bridge.trigger(); await bridge.trigger();
  check('reconnect/pull never replays the unknown write', writes.length === 2 && writes.every(path => path === `/api/session/${sid}/background`));
  check('real SSE contains only fixed doorbell fields, no target secrets or commands', events.length >= 5 && events.every(event => Object.keys(event as object).sort().join(',') === 'request_id,type'));
  console.log(`RESULT PASS ${passed} integration assertions; real Hub+product adapters, OpenCode HTTP fixture only`);
} finally {
  stop.abort(); await readEvents?.catch(() => {}); hub.stop(true); oc.stop(true);
}
process.exit(0);
