// Auto-generated vendor of openai/codex's app-server-protocol/schema/typescript/v2/
// Source: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript
// DO NOT EDIT TYPES MANUALLY — re-run scripts/vendor-codex-types.sh to refresh.
//
// Phase 1.1 (#141) vendored these for agent-node's direct stdio JSON-RPC client.

// Initialize / shutdown
export type { ClientInfo } from "./ClientInfo";
export type { InitializeCapabilities } from "./InitializeCapabilities";
export type { InitializeParams } from "./InitializeParams";
export type { InitializeResponse } from "./InitializeResponse";

// Thread lifecycle
export type { Thread } from "./v2/Thread";
export type { ThreadStatus } from "./v2/ThreadStatus";
export type { ThreadActiveFlag } from "./v2/ThreadActiveFlag";
export type { ThreadStartParams } from "./v2/ThreadStartParams";
export type { ThreadStartResponse } from "./v2/ThreadStartResponse";
export type { ThreadStartedNotification } from "./v2/ThreadStartedNotification";

// Turn
export type { Turn } from "./v2/Turn";
export type { TurnStatus } from "./v2/TurnStatus";
export type { TurnStartParams } from "./v2/TurnStartParams";
export type { TurnStartResponse } from "./v2/TurnStartResponse";
export type { TurnStartedNotification } from "./v2/TurnStartedNotification";
export type { TurnCompletedNotification } from "./v2/TurnCompletedNotification";
export type { TurnPlanStep } from "./v2/TurnPlanStep";
export type { TurnPlanStepStatus } from "./v2/TurnPlanStepStatus";
export type { UserInput } from "./v2/UserInput";

// Item streaming
export type { ThreadItem } from "./v2/ThreadItem";
export type { ItemStartedNotification } from "./v2/ItemStartedNotification";
export type { ItemCompletedNotification } from "./v2/ItemCompletedNotification";
export type { AgentMessageDeltaNotification } from "./v2/AgentMessageDeltaNotification";

// Remote control status (seen on every initialize)
export type { RemoteControlConnectionStatus } from "./v2/RemoteControlConnectionStatus";
export type { RemoteControlStatusChangedNotification } from "./v2/RemoteControlStatusChangedNotification";

// MCP server startup (seen on thread/start)
export type { McpServerStartupState } from "./v2/McpServerStartupState";
export type { McpServerStatusUpdatedNotification } from "./v2/McpServerStatusUpdatedNotification";

// Common
export type { AbsolutePathBuf } from "./AbsolutePathBuf";
