import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { JournaledBringBackExecutor } from "./bring-back-journal";
import { CodexAppServerSideThreadAdapter, type SideThreadCodexClient } from "./codex-app-server-adapter";
import { SideThreadCommandConsumer } from "./command-consumer";
import { PrivateFileCommandReceiptStore } from "./command-receipts";
import { SideThreadCommandExecutor } from "./command-transport";
import { PrivateFileForkLeaseStore } from "./fork-lease";
import { materializeCommandAttachment } from "./materialize-command-attachment";
import { PrivateFileOperationLedger } from "./operation-ledger";
import { PrivateFileTerminalOutbox } from "./terminal-outbox";
import type { SideThreadCapability } from "./domain";

export const SIDE_THREAD_EVIDENCE_REVISION = "test1190-wire-v2";
export const SIDE_THREAD_CODEX_VERSION = "0.148.0";

export function detectCodexRuntimeVersion(binary = "codex"): string {
  try {
    const text = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    return text.match(/(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i)?.[1] ?? "unknown";
  } catch { return "unknown"; }
}

export function createProductionSideThreadNode(opts: {
  enabled: boolean;
  client: SideThreadCodexClient;
  hubUrl: string;
  nodeId: string;
  token: string | (() => string);
  codexHome: string;
  runtimeVersion: string;
  topology: "owned-stdio" | "owned-websocket" | "shared-websocket";
  experimentalApi: boolean;
  pollMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  fetchImpl?: typeof fetch;
}) {
  if (!opts.enabled) return disabled("runtime");
  const root = join(opts.codexHome, "agent-network-side-threads", opts.nodeId);
  const forkLeaseStore = new PrivateFileForkLeaseStore(join(root, "fork-leases"));
  // The transport receipt/native/receipt claim and the adapter's per-RPC
  // claim are distinct nested critical sections. Sharing one lock path would
  // make every real adapter command self-conflict.
  const commandClaimStore = new PrivateFileForkLeaseStore(join(root, "command-claims"));
  const adapter = new CodexAppServerSideThreadAdapter({
    client: opts.client,
    runtimeVersion: opts.runtimeVersion,
    topology: opts.topology,
    evidenceRevision: SIDE_THREAD_EVIDENCE_REVISION,
    experimentalApi: opts.experimentalApi,
    nodeId: opts.nodeId,
    operationLedger: new PrivateFileOperationLedger(join(root, "operations")),
    forkLeaseStore,
  });
  const capability = adapter.capability();
  if (!capability.supported) { adapter.close(); return disabled(capability.reason ?? "runtime", capability); }
  const terminalOutbox = new PrivateFileTerminalOutbox(join(root, "terminal-outbox"));
  const bringBack = new JournaledBringBackExecutor(join(root, "bring-back"), async (input) => {
    const response = await opts.client.request<{ turn?: { id?: string }; turnId?: string }>("turn/start", {
      threadId: input.destinationThreadId,
      clientUserMessageId: `anet-btw-bring-back:${input.clientRequestId}`,
      input: [{ type: "text", text: `[BTW bring-back]\n${input.text}` }],
    });
    const destinationTurnId = response?.turn?.id ?? response?.turnId;
    if (!destinationTurnId) throw new Error("Codex bring-back returned no turn identity");
    return { destinationTurnId };
  });
  const executor = new SideThreadCommandExecutor({
    nodeId: opts.nodeId,
    adapter,
    terminalOutbox,
    receipts: new PrivateFileCommandReceiptStore(join(root, "command-receipts")),
    claimExecution: ({ nodeId, sideThreadId, operationId }) => commandClaimStore.claimOperation(nodeId, sideThreadId, operationId),
    materializeAttachment: (grant) => materializeCommandAttachment(grant, {
      hubUrl: opts.hubUrl,
      nodeToken: typeof opts.token === "function" ? opts.token() : opts.token,
      cacheDir: join(root, "attachments"),
      fetchImpl: opts.fetchImpl,
    }),
    bringBack: (input) => bringBack.execute(input),
    onDroppedTerminal: (reason) => opts.warn?.(`[side-thread] dropped terminal: ${reason}`),
  });
  const consumer = new SideThreadCommandConsumer({
    hubUrl: opts.hubUrl, nodeId: opts.nodeId, token: opts.token,
    executor, terminalOutbox, fetchImpl: opts.fetchImpl,
  });
  let closed = false;
  const tick = () => consumer.trigger().catch((error) => opts.warn?.(`[side-thread] poll failed: ${error instanceof Error ? error.message : String(error)}`));
  const timer = setInterval(tick, opts.pollMs ?? 1_000); timer.unref?.();
  void tick();
  opts.log?.(`[side-thread] dedicated consumer enabled (${capability.runtimeVersion}, ${capability.topology})`);
  return {
    enabled: true as const,
    capability,
    close() {
      if (closed) return; closed = true; clearInterval(timer); consumer.stop(); executor.close(); adapter.close();
    },
  };
}

/** The single production startup seam used by agent-node CLI. Tests may
 * inject a protocol-faithful client, while authentication and transport stay
 * on the real Hub/node boundary. */
export const startCliSideThreadConsumer = createProductionSideThreadNode;

function disabled(reason: NonNullable<SideThreadCapability["reason"]>, capability?: SideThreadCapability) {
  return {
    enabled: false as const,
    capability: capability ?? {
      supported: false, runtime: "codex-app-server", runtimeVersion: "unknown",
      topology: "unknown", evidenceRevision: SIDE_THREAD_EVIDENCE_REVISION, reason,
    },
    close() {},
  };
}
