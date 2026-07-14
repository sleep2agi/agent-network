import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runGatewayInboxCycle, type PumpRow } from "../../agent-node/src/runtime/codex-policy-gateway/inbox-pump";

const ROOT = "/repo";
const cli = readFileSync(`${ROOT}/agent-node/src/cli.ts`, "utf8");
const anetCli = readFileSync(`${ROOT}/agent-network/bin/cli.ts`, "utf8");
const agentNodePackage = JSON.parse(
  readFileSync(`${ROOT}/agent-node/package.json`, "utf8"),
) as { optionalDependencies?: Record<string, string> };
const assembly = readFileSync(
  `${ROOT}/agent-node/src/runtime/codex-policy-gateway/gateway-assembly.ts`,
  "utf8",
);

let passed = 0;
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`ok ${passed}: ${label}`);
}

function section(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  check(a >= 0, `section start exists: ${start}`);
  check(b > a, `section end follows: ${end}`);
  return source.slice(a, b);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

check(
  sha256(`${ROOT}/agent-node/src/runtime/codex-policy-gateway/contract.ts`) ===
    "b36dd3f586aebae3960ec825ae1b978dfb36504ddb3590d76248c8f1dd5581f3",
  "contract.ts stays at final-A frozen digest",
);
check(
  sha256(`${ROOT}/agent-node/src/runtime/codex-policy-gateway/protocol.ts`) ===
    "9488231872eb7341c3abb00cc89ff0dea87f3f80fcc90ef6c315c1299e278b9e",
  "protocol.ts stays at final-A frozen digest",
);

const direct = section(
  cli,
  "async function processWithCodexAppServer(",
  "async function processWithGrok(",
);
check(direct.includes("direct runtime is disabled"), "legacy direct runtime fails closed");
check(!direct.includes("openCodexAppServerRuntime"), "legacy function cannot open an upstream session");
check(!direct.includes("processCodexAppServerTask"), "legacy function cannot dispatch a task");

const start = section(
  cli,
  "async function startCodexGatewayProduction()",
  "async function handleGatewayOrdinaryInboxRow(",
);
check(start.includes("assembleCodexGateway"), "production starter imports assembly");
check(start.includes("await assembleCodexGateway({"), "production starter awaits assembly");
check(start.includes("codexGatewayHandle = handle"), "production starter retains gateway handle");
check(start.includes('configuredApproval !== "never"'), "non-never approval is refused");
check(start.includes('configuredSandbox !== "read-only"'), "non-read-only sandbox is refused");

check(
  anetCli.includes("function codexAppServerPhase1Flags()") &&
    anetCli.includes('approvalPolicy: "never"') &&
    anetCli.includes('sandboxMode: "read-only"'),
  "anet CLI creates codex-app-server nodes with the fixed Phase-1 profile",
);
check(
  agentNodePackage.optionalDependencies?.["@openai/codex"] === "0.144.0",
  "agent-node supplies the exact production Codex baseline",
);
check(
  anetCli.includes('const CODEX_APP_SERVER_PIN = "0.144.0"') &&
    anetCli.includes("checkCodexAppServerPin()"),
  "anet start fails early unless the exact Codex baseline is present",
);
check(
  anetCli.includes('explicitRuntime === "codex-app-server"') &&
    anetCli.includes('{ value: "codex-app-server", name: "codex-app-server'),
  "explicit and interactive create paths retain codex-app-server runtime",
);
check(
  anetCli.includes("共享 codexAppServerUrl 会 fail-closed"),
  "anet CLI no longer advertises unverifiable shared-app-server adoption",
);
check(
  cli.includes('RFC030_STAGE2_AGENT_NODE_CAPABILITY = "rfc030-stage2-ab-v1"') &&
    anetCli.includes('RFC030_STAGE2_AGENT_NODE_CAPABILITY = "rfc030-stage2-ab-v1"'),
  "anet and agent-node share an exact Stage2 capability handshake",
);
const launchBranch = section(
  anetCli,
  "async function launchAgent(id: string, forceNewSession = false)",
  "// ── start (new session) ──",
);
check(
  launchBranch.includes('runtime === "codex-app-server" ||'),
  "anet node start routes codex-app-server through the agent-node branch",
);
check(
  launchBranch.includes("verifiedCodexGatewayAgentNode!.path") &&
    launchBranch.includes('runtime !== "codex-app-server"'),
  "Stage2 executes the capability-probed local agent-node and cannot use preview fallback",
);

const inbox = section(cli, "async function processInbox()", "async function connectSSE()");
const gatewayBranch = inbox.indexOf('if (RUNTIME === "codex-app-server")');
const gatewayCycle = inbox.indexOf("await processGatewayInboxWindow()", gatewayBranch);
const legacyDrain = inbox.indexOf("await drainPendingReplies()", gatewayBranch);
check(gatewayBranch >= 0 && gatewayCycle > gatewayBranch, "processInbox routes gateway runtime to real cycle");
check(gatewayCycle < legacyDrain, "gateway returns before legacy direct task flow");

const cycle = section(
  cli,
  "function processGatewayInboxWindow()",
  "async function processInbox()",
);
check(cycle.includes("const rows = await adapter.readInbox(signal)"), "cycle consumes the H1 lease adapter inbox");
check(cycle.includes("handle.runInboxCycle("), "cycle uses mixed-window demux, not task-only pump");
check(cycle.includes("adapter.deadLetter(request, signal)"), "invalid formal rows delegate to server-owned H1 dead-letter");
check(cycle.includes("await scheduleCodexGatewayReplyDrain()"), "cycle drains durable replies");
const ordinaryHandler = section(
  cli,
  "async function handleGatewayOrdinaryInboxRow(",
  "function scheduleCodexGatewayReplyDrain()",
);
check(
  ordinaryHandler.includes("injectOrdinaryInboxRow(row, handle.scheduler"),
  "ordinary message/reply/broadcast enters the same durable scheduler",
);
check(
  ordinaryHandler.includes("adapter.quarantineOrdinary(request, signal)"),
  "ordinary invalid rows use audit-only H1 quarantine, never task dead-letter",
);

const reply = section(
  cli,
  "function scheduleCodexGatewayReplyDrain()",
  "function processGatewayInboxWindow()",
);
check(reply.includes("handle.drainReplies("), "reply_pending rows use assembly drain");
check(reply.includes("adapter.deliverOutcome(reply"), "outcome routing delegates only to the canonical H1 adapter");
check(!reply.includes("routeHintDisplayAlias"), "display alias cannot route a gateway reply");
check(!reply.includes('callCommHub("send_reply"'), "pre-H1 gateway has no alias-based reply fallback");
check(
  cli.includes("let codexGatewayH1Adapter: CodexGatewayH1Adapter | null = null") &&
    cli.includes("#440 H1 adapter unavailable; inbox and replies remain durably fenced"),
  "pre-H1 production ingress/reply stays explicitly fail-closed",
);

const startup = section(cli, "if (RUNTIME === \"codex-app-server\") {\n  // Eager", "// RFC-027 §2.5");
check(
  startup.indexOf("await startCodexGatewayProduction()") < startup.indexOf("await register()"),
  "assembly is eager before registration and initial consumption",
);
check(startup.includes("processInbox().catch"), "CLI initial scan reaches production inbox entry");

const sse = section(cli, "async function connectSSE()", "// ── 启动 ──");
check(sse.includes('["new_task", "broadcast"]'), "SSE doorbell recognizes formal task events");
check(
  sse.includes('["new_message", "new_reply", "chained_reply"]'),
  "SSE doorbell recognizes ordinary gateway ingress events",
);
check(sse.includes("await processInbox()"), "SSE doorbell enters the same production cycle");

const getInbox = section(cli, "const getInbox = async () =>", "const ackMessage = async");
check(getInbox.includes('callCommHub("get_inbox"'), "inbox uses existing CommHub MCP client");
const commhub = section(cli, "async function callCommHub(", "// #146 PR-4");
check(commhub.includes('fetch(`${COMMHUB_URL}/mcp`'), "CommHub client uses the real MCP HTTP endpoint");

const shutdown = section(cli, "function shutdown(exitCode = 0): Promise<void>", "process.on(\"SIGINT\"");
check(shutdown.includes("nodeShuttingDown = true"), "shutdown fences new gateway work synchronously");
check(shutdown.includes("nodeShutdownExitCode = exitCode"), "fatal gateway terminal can request supervisor restart");
check(shutdown.includes("gateway.stop()"), "shutdown awaits retained assembly handle");
check(shutdown.includes("gateway.forceStopOwned()"), "shutdown timeout kills owned process groups before exit");

check(assembly.includes("spawnOwnedCodexUpstream({"), "assembly owns a spawn-only provider");
check(assembly.includes("new CodexUpstreamTransport({"), "assembly owns one real transport");
check(assembly.includes("identity: spawned.identity"), "provider and TUI share one canonical binary identity");
check(assembly.includes("runGatewayInboxCycle("), "assembly exposes mixed-window ingress");
check(assembly.includes("ledger.outboundPending()"), "assembly drains success/failure/cancel outbox state");
check(assembly.includes("ledger.recover(new Map())"), "assembly classifies durable rows before ingress");
check(assembly.includes("scheduler.restoreRecoveredQueue"), "safe queued rows return to the scheduler without resend ambiguity");
check(!assembly.includes("routeHintDisplayAlias"), "assembly exposes no display-alias reply route");

const events: string[] = [];
const acked: string[] = [];
const ordinary: string[] = [];
const deadLettered: string[] = [];
const rows: PumpRow[] = [
  {
    id: "m-task-good",
    type: "task",
    content: "do the formal work",
    from_session: "display-only",
    sender_token_id: "tok-stamped",
    sender_role: "node",
    network_id: "net-1",
    canonical_task_id: "task-canonical-1",
  },
  { id: "m-message", type: "message", content: "ordinary" },
  {
    id: "m-task-forged",
    type: "task",
    content: "must fail closed",
    from_session: "forged-alias",
    network_id: "net-1",
    canonical_task_id: "task-canonical-2",
  },
];

const report = await runGatewayInboxCycle(
  rows,
  {
    async enqueueTask(args) {
      events.push(`enqueue:${String(args.messageId)}`);
      return {
        outcome: "accepted" as const,
        taskId: args.taskId,
        queuePosition: null,
        duplicate: false,
      };
    },
  },
  {
    async ack(messageId) {
      acked.push(messageId);
      events.push(`ack:${messageId}`);
    },
    async deadLetter(req) {
      deadLettered.push(req.messageId);
      events.push(`dead:${req.messageId}`);
      return { outcome: "quarantined" as const };
    },
  },
  async (row) => {
    ordinary.push(row.id);
    events.push(`ordinary:${row.id}`);
  },
);

check(
  events.join(",") ===
    "enqueue:m-task-good,ack:m-task-good,ordinary:m-message,dead:m-task-forged",
  "mixed inbox preserves server FIFO while visiting every row",
);
check(report.ordinaryDelivered === 1 && ordinary[0] === "m-message", "ordinary row delivered exactly once");
check(report.enqueued.length === 1 && report.enqueued[0].taskId === "task-canonical-1", "stamped task enqueued with canonical id");
check(acked.length === 1 && acked[0] === "m-task-good", "only durable accepted task ACKed by gateway hook");
check(deadLettered.length === 1 && deadLettered[0] === "m-task-forged", "alias-only forged principal fails closed");

console.log(`wiring probe PASS: ${passed}/${passed}`);
