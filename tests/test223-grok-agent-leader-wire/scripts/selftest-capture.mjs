import { ByteRecorder } from "../lib/byte-recorder.mjs";

const output = process.argv[2];
if (!output) throw new Error("usage: selftest-capture.mjs OUTPUT");

function nativeFrame(outer) {
  const payload = Buffer.from(JSON.stringify(outer));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

let syntheticMonoNs = 0n;
const recorder = new ByteRecorder(output, "harness-canary", {
  pid: 4242,
  generation: 1,
  leader: { pid: 5151 },
}, {
  now: () => {
    const value = syntheticMonoNs;
    syntheticMonoNs += 1_000_000n;
    return value;
  },
});

try {
  // The token is deliberately split across write boundaries. The next write
  // also coalesces the end of one JSON frame and a second complete frame.
  recorder.record({
    role: "synthetic-client",
    transport: "acp-stdio",
    connection: "stdio-1",
    stream: "stdin",
    direction: "client_to_grok",
    boundary: "write",
    bytes: Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"token":"CAPTURE_TOKEN_',
    ),
  });
  recorder.record({
    role: "synthetic-client",
    transport: "acp-stdio",
    connection: "stdio-1",
    stream: "stdin",
    direction: "client_to_grok",
    boundary: "write",
    bytes: Buffer.from(
      'CANARY_ALPHA","email":"CAPTURE_ACCOUNT_CANARY_ALPHA","cwd":"CAPTURE_PATH_CANARY_ALPHA"}}\n'
      + '{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"session-safe"}}\n',
    ),
  });

  recorder.record({
    role: "synthetic-grok",
    transport: "acp-stdio",
    connection: "stdio-1",
    stream: "stdout",
    direction: "grok_to_client",
    boundary: "read",
    bytes: Buffer.from(
      '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}\n'
      + '{"jsonrpc":"2.0","id":2,"result":',
    ),
  });

  // Unknown HTTP/WS bytes exercise the opaque projection and repeat the same
  // canary so stable placeholder assignment can be checked independently.
  recorder.record({
    role: "synthetic-ws-client",
    transport: "serve-websocket-upgrade",
    connection: "ws-1",
    stream: "socket",
    direction: "client_to_grok",
    boundary: "write",
    bytes: Buffer.from(
      'GET /ws?server-key=CAPTURE_TOKEN_CANARY_ALPHA HTTP/1.1\r\n'
      + 'Authorization: Bearer CAPTURE_TOKEN_CANARY_ALPHA\r\n'
      + 'X-Account: CAPTURE_ACCOUNT_CANARY_ALPHA\r\n\r\n',
    ),
  });

  const register = nativeFrame({ type: "register", client: "tui", generation: 1 });
  const acp = nativeFrame({
    type: "acp",
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {
        prompt: "CAPTURE_BODY_CANARY_NATIVE_PROMPT",
        content: [{ type: "text", text: "CAPTURE_BODY_CANARY_NATIVE_TEXT" }],
        reasoning: "CAPTURE_BODY_CANARY_NATIVE_REASONING",
        encrypted_content: "CAPTURE_BODY_CANARY_NATIVE_ENCRYPTED",
        rawInput: "CAPTURE_BODY_CANARY_NATIVE_RAW_INPUT",
        title: "CAPTURE_BODY_CANARY_NATIVE_TITLE",
        identityProbe: {
          agentId: "CAPTURE_IDENTITY_CANARY_AGENT",
          agentInstanceId: "CAPTURE_IDENTITY_CANARY_AGENT_INSTANCE",
          agentName: "CAPTURE_IDENTITY_CANARY_AGENT_NAME",
          hostname: "CAPTURE_HOST_CANARY_MACHINE",
          team_id: "CAPTURE_TEAM_CANARY_SNAKE",
          teamId: "CAPTURE_TEAM_CANARY_CAMEL",
          team_name: "CAPTURE_TEAM_CANARY_NAME",
          nodeId: "CAPTURE_NODE_CANARY_NODE",
          nodeName: "CAPTURE_NODE_CANARY_NODE_NAME",
          userId: "CAPTURE_USER_CANARY_USER",
          userName: "CAPTURE_USER_CANARY_USER_NAME",
          accountId: "CAPTURE_ACCOUNT_CANARY_ACCOUNT_ID",
          machineId: "CAPTURE_MACHINE_CANARY_MACHINE_ID",
          machineName: "CAPTURE_MACHINE_CANARY_MACHINE_NAME",
          currentWorkingDirectory: "/tmp/CAPTURE_PATH_CANARY_NATIVE_CWD",
          command: "run /tmp/CAPTURE_PATH_CANARY_COMMAND_TARGET",
          argv: ["client-command", "/tmp/CAPTURE_PATH_CANARY_ARGV_TARGET"],
          availableCommands: [{
            name: "CAPTURE_COMMAND_CANARY_AVAILABLE_NAME",
            description: "CAPTURE_COMMAND_CANARY_AVAILABLE_DESCRIPTION",
            input: { hint: "CAPTURE_COMMAND_CANARY_AVAILABLE_HINT" },
          }],
          clientId: 9876,
          nested: {
            clientId: 9876,
            pid: 4567,
            hostname: "CAPTURE_HOST_CANARY_MACHINE",
            currentWorkingDirectory: "/tmp/CAPTURE_PATH_CANARY_NATIVE_CWD",
          },
          pid: 4567,
        },
        structuralAllowlistProbe: {
          rawUuid: "123e4567-e89b-12d3-a456-426614174000",
          sessionId: "raw-session-value",
          promptId: "raw-prompt-value",
          account: { email: "用户@例子.公司", accountId: "raw-account-value" },
          billing: { amount: 987.65, currency: "USD", active: true },
          path: "/工作区/秘密/文件.txt",
          body: "free-form body must not persist",
          user: "raw-user-value",
          input: "raw-input-value",
          output: "raw-output-value",
          password: "raw-password-value",
          apiKey: "raw-api-key-value",
          cookie: "raw-cookie-value",
          sid: "raw-sid-value",
          filter_session_id: "raw-filter-session-value",
          runningPromptId: "raw-running-prompt-value",
          session_summary: "raw-session-summary-value",
          prompts: ["raw-prompt-history-value"],
          message: "raw-message-value",
          ansiSplitSecret: "sk-\u001b[31msplit-secret",
          controlSplitSecret: "ntok_\u0000split-secret",
          unicodeEmail: "用户@例子.公司",
          unicodePath: "/工作区/秘密/另一个文件.txt",
          logs: ["free-form log entry"],
          history: [{ message: "free-form history entry" }],
        },
      },
    }),
  });
  const ping = nativeFrame({ type: "ping", nonce: "safe-nonce" });
  // A length prefix split across reads, followed by two frames coalesced into
  // one read. This is the shape a frame-aware native IPC proxy must accept.
  recorder.record({
    role: "synthetic-tui",
    transport: "leader-native-ipc",
    connection: "native-1",
    stream: "socket",
    direction: "tui_to_gateway",
    boundary: "read",
    bytes: register.subarray(0, 3),
  });
  recorder.record({
    role: "synthetic-tui",
    transport: "leader-native-ipc",
    connection: "native-1",
    stream: "socket",
    direction: "tui_to_gateway",
    boundary: "read",
    bytes: Buffer.concat([register.subarray(3), acp, ping]),
  });
  recorder.record({
    role: "synthetic-tui",
    transport: "leader-native-ipc",
    connection: "native-1",
    stream: "socket",
    direction: "tui_to_gateway",
    boundary: "eof",
    bytes: Buffer.alloc(0),
  });

  const registered = nativeFrame({ type: "registered", generation: 1 });
  const truncatedHeader = Buffer.alloc(4);
  truncatedHeader.writeUInt32BE(32);
  recorder.record({
    role: "synthetic-gateway",
    transport: "leader-native-ipc",
    connection: "native-2",
    stream: "socket",
    direction: "gateway_to_tui",
    boundary: "read",
    bytes: Buffer.concat([registered, truncatedHeader, Buffer.from('{"type":"acp"')]),
  });
  recorder.record({
    role: "synthetic-gateway",
    transport: "leader-native-ipc",
    connection: "native-2",
    stream: "socket",
    direction: "gateway_to_tui",
    boundary: "eof",
    bytes: Buffer.alloc(0),
  });

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE((1024 * 1024) + 1);
  recorder.record({
    role: "synthetic-attacker",
    transport: "leader-native-ipc",
    connection: "native-oversized",
    stream: "socket",
    direction: "client_to_gateway",
    boundary: "read",
    bytes: oversizedHeader,
  });
  recorder.record({
    role: "synthetic-attacker",
    transport: "leader-native-ipc",
    connection: "native-oversized",
    stream: "socket",
    direction: "client_to_gateway",
    boundary: "eof",
    bytes: Buffer.alloc(0),
  });
} finally {
  recorder.close();
}
