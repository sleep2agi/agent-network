// #5675 PR-3 — Hub-side tests for hot secret activation:
//   - report_status / /api/status projects `secrets_hot_capable: true` ONLY when reported
//   - ackNodeSecrets & ackScopedSecrets accept all 4 activation states (next_start, hot_applied, hot_pending_idle, shadowed)
//     and reject unknown values
//   - node_secret_reload works over both MCP and REST without revision
//   - daemon ackScopedSecrets on put/delete pushes `node_secrets_reload` SSE doorbell to affected child(ren) WITHOUT value
//   - negative echo control across REST, MCP, and SSE payloads

import './require-explicit-test-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DIR = mkdtempSync(join(tmpdir(), 'anet-hot-secrets-hub-'));
process.env.COMMHUB_DB ||= join(DIR, 'hub.db');

let hubServer: ReturnType<typeof Bun.serve>;
let hubBase = '';
let ownerToken = '';
let net = '';
let ownerUserId = '';

const HOT_NODE = 'n_hot_claude';
const NON_HOT_NODE = 'n_plain_opencode';
const DAEMON_NODE = 'n_hot_daemon';
const CHILD_A = 'n_hot_child_a';
const CHILD_B = 'n_hot_child_b';

beforeAll(async () => {
  const { db } = await import('./db.js');
  const { register } = await import('./auth.js');
  const stamp = Date.now();

  const owner = register(`hot_owner_${stamp}`, 'HotOwner-Strong-1!');
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  net = owner.network_id!;
  ownerUserId = db.get<{ user_id: string }>('SELECT user_id FROM users WHERE username = ?1', `hot_owner_${stamp}`)!.user_id;

  const insertNodeAndSession = (nodeId: string, alias: string, snap: Record<string, unknown>, agent = 'agent-node:claude') => {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state, config_snapshot)
       VALUES (?1, ?2, ?2, ?3, 'active', ?4)`,
      [nodeId, alias, net, JSON.stringify(snap)],
    );
    db.run(
      `INSERT INTO sessions (resume_id, alias, node_id, network_id, agent, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'idle')`,
      [`sdk-${nodeId}`, alias, nodeId, net, agent],
    );
    db.run(
      `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, bound_node_id)
       VALUES (?1, ?2, ?3, 'network', ?4, 'TEST-ONLY-hash', ?5)`,
      [`tok_${nodeId}`, ownerUserId, net, `node:${alias}`, nodeId],
    );
  };

  insertNodeAndSession(HOT_NODE, 'hot-claude', { node_secrets_capable: true, secrets_hot_capable: true }, 'agent-node:claude');
  insertNodeAndSession(NON_HOT_NODE, 'plain-opencode', { node_secrets_capable: true }, 'agent-node:opencode');
  insertNodeAndSession(DAEMON_NODE, 'hot-daemon', { role: 'host_supervisor', scoped_secrets_capable: true }, 'agent-node:daemon');
  insertNodeAndSession(CHILD_A, 'hot-child-a', { node_secrets_capable: true, secrets_hot_capable: true }, 'agent-node:codex-app-server');
  insertNodeAndSession(CHILD_B, 'hot-child-b', { node_secrets_capable: true, secrets_hot_capable: true }, 'agent-node:antigravity');

  for (const [reqId, childId] of [['bind_a', CHILD_A], ['bind_b', CHILD_B]]) {
    db.run(
      `INSERT INTO node_daemon_bindings (request_id, network_id, node_id, daemon_node_id, workdir, requested_by, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, '/tmp/hot-child', ?5, 'active', 0, 0)`,
      [reqId, net, childId, DAEMON_NODE, ownerUserId],
    );
  }

  const mod = await import('./server.js');
  hubServer = mod.bootServer({ port: 0, hostname: '127.0.0.1' });
  hubBase = `http://127.0.0.1:${hubServer.port}`;
});

afterAll(() => {
  try { hubServer?.stop(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

async function makeMcpClient(asNode?: { nodeId: string; alias: string }) {
  const { registerTools } = await import('./tools.js');
  const handlers: Record<string, any> = {};
  const server = new McpServer({ name: 'hot-secrets-hub-test', version: '0' }) as any;
  const origTool = server.tool.bind(server);
  const origReg = server.registerTool.bind(server);
  server.tool = (name: string, desc: any, schema: any, handler: any) => {
    handlers[name] = handler;
    return origTool(name, desc, schema, handler);
  };
  server.registerTool = (name: string, cfg: any, handler: any) => {
    handlers[name] = handler;
    return origReg(name, cfg, handler);
  };
  registerTools(
    server,
    undefined,
    asNode ? net : null,
    ownerUserId,
    asNode ? asNode.alias : 'owner',
    !!asNode,
    asNode ? `tok_${asNode.nodeId}` : null,
  );
  return async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse((await handlers[name](args)).content[0].text);
}

describe('#5675 PR-3 Hub capability, activation states, daemon->child doorbell, and negative echo', () => {
  test('/api/status projects secrets_hot_capable ONLY for nodes that advertise it', async () => {
    const r = await fetch(`${hubBase}/api/status?network_id=${net}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { sessions: any[] };
    const byAlias = new Map(body.sessions.map((s) => [s.alias, s]));
    expect(byAlias.get('hot-claude')?.secrets_hot_capable).toBe(true);
    expect(byAlias.get('hot-claude')?.node_secrets_capable).toBe(true);
    expect(byAlias.get('plain-opencode')?.node_secrets_capable).toBe(true);
    expect('secrets_hot_capable' in (byAlias.get('plain-opencode') ?? {})).toBe(false);
    expect('secrets_hot_capable' in (byAlias.get('hot-daemon') ?? {})).toBe(false);
  });

  test('ackNodeSecrets accepts all 4 activation states (next_start, hot_applied, hot_pending_idle, shadowed) and rejects unknown activation', async () => {
    const { requestNodeSecrets, ackNodeSecrets, getScopedSecrets } = await import('./scoped-secrets.js');
    const human = { userId: ownerUserId, isNode: false, networkId: net };
    const nodeCaller = { ok: true as const, networkId: net, daemonNodeId: HOT_NODE, daemonAlias: 'hot-claude' };

    for (const [idx, activation] of (['next_start', 'hot_applied', 'hot_pending_idle', 'shadowed'] as const).entries()) {
      const req = requestNodeSecrets(human, HOT_NODE, 'put', `KEY_${idx}`, `sk-val-${idx}`, idx);
      expect(req.ok).toBe(true);
      if (!req.ok) continue;
      const ack = ackNodeSecrets(nodeCaller, req.request_id, {
        network_id: net,
        daemon_node_id: null,
        node_id: HOT_NODE,
        revision: idx + 1,
        activation,
        keys: [{ key: `KEY_${idx}`, source: 'node' }],
      });
      expect(ack.ok).toBe(true);
      const read = getScopedSecrets(human, req.request_id);
      expect(read.ok && read.snapshot.activation).toBe(activation);
      expect(JSON.stringify(read)).not.toContain(`sk-val-${idx}`);
    }

    // Unknown activation string MUST be rejected
    const badReq = requestNodeSecrets(human, HOT_NODE, 'reload', 'KEY_0');
    expect(badReq.ok).toBe(true);
    if (badReq.ok) {
      const badAck = ackNodeSecrets(nodeCaller, badReq.request_id, {
        network_id: net,
        daemon_node_id: null,
        node_id: HOT_NODE,
        revision: 4,
        activation: 'invented_mode',
        keys: [],
      });
      expect(badAck.ok).toBe(false);
      if (!badAck.ok) expect(badAck.error).toBe('invalid_secret_receipt');
      // Drain pending so next tests have clean queue
      ackNodeSecrets(nodeCaller, badReq.request_id, null, true);
    }
  });

  test('node_secret_reload works via REST and MCP without revision and surfaces exact child activation', async () => {
    const { ackNodeSecrets } = await import('./scoped-secrets.js');
    const r = await fetch(`${hubBase}/api/nodes/${HOT_NODE}/secrets?network_id=${net}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reload', key: 'OPENAI_API_KEY' }),
    });
    expect(r.status).toBe(200);
    const created = await r.json() as any;
    expect(created.ok).toBe(true);
    expect(String(created.request_id)).toStartWith('nsk_');

    const acked = ackNodeSecrets(
      { ok: true, networkId: net, daemonNodeId: HOT_NODE, daemonAlias: 'hot-claude' },
      created.request_id,
      { network_id: net, daemon_node_id: null, node_id: HOT_NODE, revision: 4, activation: 'shadowed', keys: [] },
    );
    expect(acked.ok).toBe(true);

    const polled = await fetch(`${hubBase}/api/nodes/${HOT_NODE}/secrets/${created.request_id}?network_id=${net}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }).then((res) => res.json() as Promise<any>);
    expect(polled.status).toBe('succeeded');
    expect(polled.snapshot.activation).toBe('shadowed');
  });

  test('daemon ackScopedSecrets pushes node_secrets_reload SSE doorbell to bound child(ren) with ZERO secret value', async () => {
    const { createSSEStream } = await import('./push.js');
    const childAEvents: any[] = [];
    const childBEvents: any[] = [];

    const openSub = (alias: string, sink: any[]) => {
      const res = createSSEStream(alias, net);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of block.split('\n')) {
                if (line.startsWith('data: ')) {
                  try { sink.push(JSON.parse(line.slice(6))); } catch {}
                }
              }
            }
          }
        } catch { /* stream cancelled in finally */ }
      })();
      return { close: async () => { await reader.cancel().catch(() => {}); await pump; } };
    };

    const subA = openSub('hot-child-a', childAEvents);
    const subB = openSub('hot-child-b', childBEvents);
    const waitTick = () => new Promise((r) => setTimeout(r, 25));
    const secretNeedle = `sk-DOORBELL-ECHO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const human = await makeMcpClient();
      const daemon = await makeMcpClient({ nodeId: DAEMON_NODE, alias: 'hot-daemon' });

      // 1. Single-child put -> ONLY child A receives node_secrets_reload doorbell (never secret value!)
      const reqA = await human('daemon_provider_snapshot', {
        action: 'secret_put',
        id: DAEMON_NODE,
        network_id: net,
        revision: 0,
        provider: { node_id: CHILD_A, key: 'CHILD_A_KEY', value: secretNeedle },
      });
      expect(reqA.ok).toBe(true);
      expect(JSON.stringify(reqA)).not.toContain(secretNeedle);

      const ackA = await daemon('ack_daemon_provider_snapshot', {
        request_id: reqA.request_id,
        snapshot: {
          network_id: net,
          daemon_node_id: DAEMON_NODE,
          node_id: CHILD_A,
          revision: 1,
          activation: 'next_start',
          keys: [{ key: 'CHILD_A_KEY', source: 'node' }],
        },
      });
      expect(ackA.ok).toBe(true);
      expect('notify_children' in ackA).toBe(false);
      await waitTick();

      const reloadA = childAEvents.filter((e) => e.type === 'node_secrets_reload');
      expect(reloadA).toHaveLength(1);
      expect(reloadA[0]).toMatchObject({ type: 'node_secrets_reload', key: 'CHILD_A_KEY', action: 'put', source: 'daemon', revision: 1 });
      expect(childBEvents.filter((e) => e.type === 'node_secrets_reload')).toHaveLength(0);

      // 2. Daemon-wide default put (node_id: null) -> BOTH bound children A & B receive doorbell!
      const reqAll = await human('daemon_provider_snapshot', {
        action: 'secret_put',
        id: DAEMON_NODE,
        network_id: net,
        revision: 1,
        provider: { node_id: null, key: 'DAEMON_SHARED_KEY', value: secretNeedle },
      });
      expect(reqAll.ok).toBe(true);
      const ackAll = await daemon('ack_daemon_provider_snapshot', {
        request_id: reqAll.request_id,
        snapshot: {
          network_id: net,
          daemon_node_id: DAEMON_NODE,
          node_id: null,
          revision: 2,
          activation: 'next_start',
          keys: [{ key: 'DAEMON_SHARED_KEY', source: 'daemon' }],
        },
      });
      expect(ackAll.ok).toBe(true);
      await waitTick();

      expect(childAEvents.filter((e) => e.type === 'node_secrets_reload' && e.key === 'DAEMON_SHARED_KEY')).toHaveLength(1);
      expect(childBEvents.filter((e) => e.type === 'node_secrets_reload' && e.key === 'DAEMON_SHARED_KEY')).toHaveLength(1);

      // Negative echo control: secret value MUST NOT appear in any SSE event or MCP response
      expect(JSON.stringify(childAEvents)).not.toContain(secretNeedle);
      expect(JSON.stringify(childBEvents)).not.toContain(secretNeedle);
      expect(JSON.stringify(ackA)).not.toContain(secretNeedle);
      expect(JSON.stringify(ackAll)).not.toContain(secretNeedle);
    } finally {
      await subA.close();
      await subB.close();
    }
  });
});
