// Node 22 executes the production daemon handler, including its pinned CLI.
import { reconcileProviderSnapshots } from '/work/snapshot-reader.mjs';
let input = ''; for await (const part of process.stdin) input += part;
const { token, ...deps } = JSON.parse(input);
await reconcileProviderSnapshots({ ...deps, warn: () => { throw Error('reconcile warning'); },
  callCommHub: async (name, args) => {
    const response = await fetch(deps.serverUrl + '/mcp', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    if (!response.ok) throw Error('fixture HTTP failure');
    const raw = await response.text(), line = raw.split('\n').filter(x => x.startsWith('data:')).at(-1);
    const result = JSON.parse(line ? line.slice(5) : raw);
    if (result.error || result.result?.isError) throw Error('fixture MCP failure');
    return JSON.parse(result.result.content[0].text);
  },
});
console.log('handler completed');
