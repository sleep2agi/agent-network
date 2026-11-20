#!/usr/bin/env node
'use strict';
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const requireWorkspace = createRequire(resolve(__dirname, '../../agent-network/package.json'));
const { WebSocket, WebSocketServer } = requireWorkspace('ws');
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 512 * 1024 * 1024;
const PREVIEW_BYTES = 2048;

function previewHistory(message, maxPreviewBytes = PREVIEW_BYTES) {
  const thread = message?.result?.thread;
  if (!Array.isArray(thread?.turns)) return { changed: 0 };
  let changed = 0;
  for (const turn of thread.turns) {
    for (const item of turn.items || []) {
      if (item.type !== 'mcpToolCall' || !item.result) continue;
      const serialized = JSON.stringify(item.result);
      if (Buffer.byteLength(serialized) <= maxPreviewBytes) continue;
      const text = (item.result.content || []).filter(part => part.type === 'text')
        .map(part => part.text || '').join('\n') || serialized;
      const bytes = Buffer.from(text);
      const preview = bytes.subarray(0, maxPreviewBytes).toString('utf8');
      item.result = {
        content: [{ type: 'text', text: preview + '\n[历史工具输出预览；完整输出保留在原始会话文件中]' }],
        structuredContent: null,
        _meta: null,
      };
      changed++;
    }
  }
  return { changed };
}

function startProxy({ upstreamUrl, port, threadId, onLog = console.log }) {
  const url = new URL(upstreamUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Upstream must be a local ws:// endpoint');
  }
  if (!threadId || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy configuration');
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_UPSTREAM_BYTES });
  const sockets = new Set();
  server.on('connection', client => {
    sockets.add(client);
    const upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_UPSTREAM_BYTES });
    sockets.add(upstream);
    const pending = new Map();
    const queue = [];
    let isTui = false;
    upstream.on('open', () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
    client.on('message', (data, binary) => {
      try {
        const message = JSON.parse(data);
        if (message.method === 'initialize') isTui = message.params?.clientInfo?.name === 'codex-tui';
        if (message.id !== undefined) pending.set(message.id, {
          history: isTui && message.method === 'thread/read' && message.params?.includeTurns === true
            && message.params?.threadId === threadId,
        });
      } catch { /* Forward all non-JSON payloads without changing them. */ }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else queue.push([data, binary]);
    });
    upstream.on('message', (data, binary) => {
      let outgoing = data;
      try {
        const message = JSON.parse(data);
        const request = !message.method ? pending.get(message.id) : undefined;
        if (request) pending.delete(message.id);
        if (request?.history && data.length > MAX_RESPONSE_BYTES && message.result?.thread?.id === threadId) {
          const { changed } = previewHistory(message);
          outgoing = Buffer.from(JSON.stringify(message));
          onLog(JSON.stringify({ event: 'history-preview', inputBytes: data.length, outputBytes: outgoing.length, changed }));
          if (outgoing.length > MAX_RESPONSE_BYTES) {
            outgoing = Buffer.from(JSON.stringify({ id: message.id, error: {
              code: -32000, message: 'TUI history remains too large after tool-output previews; original history is intact',
            } }));
          }
        }
      } catch (error) {
        onLog(JSON.stringify({ event: 'proxy-error', message: error.message }));
        client.close(1011, 'History rendering failed');
        return;
      }
      if (client.readyState === WebSocket.OPEN) {
        // Native clients limit individual WebSocket frames separately from messages.
        const chunk = 1024 * 1024;
        for (let offset = 0; offset < outgoing.length; offset += chunk) {
          client.send(outgoing.subarray(offset, offset + chunk), {
            binary, fin: offset + chunk >= outgoing.length,
          }, error => { if (error) upstream.close(); });
        }
      }
    });
    client.on('close', () => { sockets.delete(client); upstream.close(); });
    upstream.on('close', () => { sockets.delete(upstream); client.close(); });
    client.on('error', () => upstream.close());
    upstream.on('error', () => client.close(1011, 'App server unavailable'));
  });
  return { server, close() { for (const socket of sockets) socket.terminate(); return new Promise(resolve => server.close(resolve)); } };
}

module.exports = { previewHistory, startProxy, MAX_RESPONSE_BYTES };
if (require.main === module) {
  const [upstreamUrl, port, threadId] = process.argv.slice(2);
  const proxy = startProxy({ upstreamUrl, port: Number(port), threadId });
  proxy.server.on('listening', () => console.log('TUI preview proxy ready on 127.0.0.1:' + port));
  proxy.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => proxy.close().then(() => process.exit()));
}
