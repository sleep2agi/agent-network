// test720 — print the commhub `-c` overrides exactly as the shipped launchers build them,
// one JSON object per launcher. The probe substitutes the fake hub for "@HUB@".
import { codexCommhubMcpOverrides, codexWindowsAppServerArgs } from "../../agent-network/src/codex-commhub-mcp";
import { buildOwnedAppServerArgs } from "../../agent-node/src/runtime/codex-app-server/runtime";

const flags = (list: string[]) => list.flatMap((o) => ["-c", o]);
const approvalPolicy = process.env.T720_APPROVAL || "on-request";
const sandboxMode = process.env.T720_SANDBOX || "read-only";
const posture = ["-c", `approval_policy=${approvalPolicy}`, "-c", `sandbox_mode=${sandboxMode}`];
const owned = buildOwnedAppServerArgs("ws://unused", { approvalPolicy, sandboxMode, commhubMcpUrl: "@HUB@/mcp" });
console.log(JSON.stringify({
  // POSIX tmux launcher (anet node start on Linux/macOS)
  posix: [...posture, ...flags(codexCommhubMcpOverrides("@HUB@", "quoted"))],
  // Windows launcher: the exact argv it hands windowsManagedProcess (bare TOML values)
  windows: (() => { const w = codexWindowsAppServerArgs({ approvalPolicy, sandboxMode, model: "gpt-5", hub: "@HUB@", wsUrl: "ws://unused" }); return w.slice(1, w.indexOf("--listen")); })(),
  // agent-node owned app-server (codex-app-server runtime without co-presence)
  agentNode: owned.slice(1, owned.indexOf("--listen")),
}));
