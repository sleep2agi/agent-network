/**
 * @sleep2agi/agent-network
 *
 * AI Agent 通信网络 — 一个包搞定 Server + Client + Setup
 *
 * Client:
 *   import { CommHub } from '@sleep2agi/agent-network';
 *   const hub = new CommHub({ url, alias });
 *   hub.on('task', (msg) => { ... });
 *
 * Server:
 *   import { startServer } from '@sleep2agi/agent-network/server';
 *   await startServer({ port: 9200 });
 */

export { CommHub } from "./client.js";
export type { CommHubOptions, CommHubEvents, InboxMessage } from "./client.js";
export { startServer } from "./server.js";
export type { ServerOptions } from "./server.js";
