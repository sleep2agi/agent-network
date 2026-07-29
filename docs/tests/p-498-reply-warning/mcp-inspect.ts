// MCP inspect v2 — verify send_reply warning field behavior.
const HUB = process.env.HUB || 'http://127.0.0.1:9251';
const UTOK = process.env.UTOK || '';

async function mcp(sessionId: string | null, method: string, params: any, id: number) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${UTOK}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${HUB}/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text);
  return { sid, payload };
}

async function main() {
  const init = await mcp(null, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'inspect', version: '0.0.1' },
  }, 0);
  const sid = init.sid;

  // 1) Show send_reply description phrases
  const list = await mcp(sid, 'tools/list', {}, 1);
  const t = list.payload?.result?.tools?.find((x: any) => x.name === 'send_reply');
  console.log('=== HARD GATE 1: send_reply description phrases ===');
  const phrases = [
    'NOT for agent-to-agent replies',
    'Use send_task for peer-to-peer replies',
    'RFC-030',
    'response includes a `warning` field',
    '全网规则',
  ];
  let p1 = 0, f1 = 0;
  for (const p of phrases) {
    const ok = t?.description?.includes(p);
    console.log(`  ${ok ? '✓' : '✗'} '${p}'`);
    ok ? p1++ : f1++;
  }
  console.log(`Gate 1: ${p1} pass / ${f1} fail\n`);

  // 2) send_reply → live agent → expect warning
  const agentTaskId = process.env.AGENT_TASK_ID || 'unset';
  const r1 = await mcp(sid, 'tools/call', {
    name: 'send_reply',
    arguments: {
      alias: 'test-agent-peer',
      text: 'test reply body (should trigger warning)',
      in_reply_to: agentTaskId,
      status: 'replied',
      from_session: process.env.FROM_SESSION || '',
    },
  }, 2);
  console.log('=== HARD GATE 2A: send_reply → live agent alias ===');
  const inner1 = r1.payload?.result?.content?.[0]?.text;
  if (typeof inner1 === 'string') {
    const parsed1 = JSON.parse(inner1);
    console.log('response payload:', JSON.stringify(parsed1, null, 2));
    let p2 = 0, f2 = 0;
    if (parsed1.warning) {
      p2++; console.log("✓ 'warning' field present");
      const w = parsed1.warning;
      for (const c of ['commhub_send_task', 'agent peers', 'not see this reply in real time', 'RFC-030', '全网规则']) {
        const ok = w.includes(c);
        console.log(`  ${ok ? '✓' : '✗'} warning contains '${c}'`);
        ok ? p2++ : f2++;
      }
    } else {
      f2++; console.log("✗ 'warning' field ABSENT");
    }
    console.log(`Gate 2A: ${p2} pass / ${f2} fail\n`);
  } else {
    console.log('parse fail:', r1.payload);
  }

  // 3) send_reply → hub (Dashboard path) → NO warning
  const hubTaskId = process.env.HUB_TASK_ID || 'unset';
  const r2 = await mcp(sid, 'tools/call', {
    name: 'send_reply',
    arguments: {
      alias: 'hub',
      text: 'test dash reply (should NOT trigger warning)',
      in_reply_to: hubTaskId,
      status: 'replied',
      from_session: process.env.FROM_SESSION || '',
    },
  }, 3);
  console.log('=== HARD GATE 2B: send_reply → hub (Dashboard alias, no warning expected) ===');
  const inner2 = r2.payload?.result?.content?.[0]?.text;
  if (typeof inner2 === 'string') {
    const parsed2 = JSON.parse(inner2);
    console.log('response payload:', JSON.stringify(parsed2, null, 2));
    if (parsed2.warning) console.log("✗ 'warning' UNEXPECTEDLY present (target=hub)");
    else console.log("✓ no 'warning' field (correct — hub is Dashboard path)");
  } else {
    console.log('parse fail:', r2.payload);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
