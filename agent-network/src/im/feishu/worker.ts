#!/usr/bin/env node
/**
 * RFC-020 §2.5 — Feishu bridge standalone worker entry (#179 M4).
 *
 * This file is the script that agent-node forks to run the Feishu bridge in
 * a child process. It is also usable standalone for debugging the inbound
 * path without an agent attached.
 *
 * Usage (standalone, no parent IPC — falls back to stderr logger):
 *   node dist/src/im/feishu/worker.js \
 *     --channel-dir /path/to/.anet/nodes/<node>/channels/feishu \
 *     --node-alias  <alias>
 *
 * Usage (forked by agent-node with IPC):
 *   child_process.fork(workerPath, [
 *     "--channel-dir", channelDir,
 *     "--node-alias",  nodeAlias,
 *   ], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
 *
 *   When `process.send` is available (IPC mode), the bridge auto-switches to
 *   forwarding inbound events to the parent and routing parent's reply text
 *   back to Feishu (see BridgeIncomingEnvelope / BridgeReplyEnvelope in
 *   ./bridge.ts).
 *
 * Milestone status:
 *   M4 (this file): standalone + IPC entry.
 *   M5: agent-node spawn site that forks this worker (see agent-node/cli.ts).
 */
import { startFeishuBridge } from "./bridge.js";

interface ParsedArgs {
  channelDir?: string;
  nodeAlias?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--channel-dir" && value) {
      out.channelDir = value;
      i++;
    } else if (flag === "--node-alias" && value) {
      out.nodeAlias = value;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.channelDir || !args.nodeAlias) {
    process.stderr.write(
      "usage: feishu-worker --channel-dir <path> --node-alias <alias>\n",
    );
    process.exit(2);
  }

  try {
    await startFeishuBridge({
      channelDir: args.channelDir,
      nodeAlias: args.nodeAlias,
    });
    process.stderr.write(
      `[feishu:worker] bridge online — node=${args.nodeAlias} dir=${args.channelDir}` +
        ` ipc=${typeof process.send === "function" ? "yes" : "no"}\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`[feishu:worker] startup failed: ${msg}\n`);
    process.exit(1);
  }
}

void main();
