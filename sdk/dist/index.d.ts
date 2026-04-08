/**
 * @sleep2agi/commhub-sdk
 *
 * CommHub 通信 SDK — 一个文件，SSE 长连接 + 自动重连 + 心跳。
 * 支持 Node.js 18+ 和 Bun。
 */
import { EventEmitter } from "events";
export interface CommHubOptions {
    /** CommHub Server URL, e.g. "http://YOUR_COMMHUB_IP:9200" */
    url: string;
    /** Session alias, e.g. "SDK马" */
    alias: string;
    /** Auth token (optional) */
    token?: string;
    /** Agent type for registration (default: "sdk") */
    agent?: string;
    /** Heartbeat interval in ms (default: 180000 = 3 min) */
    heartbeatInterval?: number;
    /** SSE reconnect base delay in ms (default: 3000) */
    reconnectDelay?: number;
    /** Auto-connect on creation (default: true) */
    autoConnect?: boolean;
}
export interface InboxMessage {
    id: string;
    content: string;
    from_session: string;
    priority: string;
    created_at: string;
}
export interface CommHubEvents {
    task: (msg: InboxMessage) => void;
    message: (msg: InboxMessage) => void;
    connected: () => void;
    disconnected: () => void;
    error: (err: Error) => void;
}
export declare class CommHub extends EventEmitter {
    private url;
    private alias;
    private token?;
    private agent;
    private resumeId;
    private heartbeatInterval;
    private reconnectDelay;
    private heartbeatTimer?;
    private sseAbort?;
    private running;
    constructor(opts: CommHubOptions);
    private log;
    private call;
    /** Connect to CommHub: register + start SSE + heartbeat */
    connect(): Promise<void>;
    /** Disconnect: stop SSE + heartbeat, report offline */
    disconnect(): Promise<void>;
    /** Send a task to another session */
    send(targetAlias: string, content: string, priority?: "high" | "normal" | "low"): Promise<any>;
    /** Send a message (no task lifecycle) */
    message(targetAlias: string, content: string): Promise<any>;
    /** Reply to a task (update status) */
    reply(taskId: string, text: string, status?: "completed" | "blocked" | "error" | "in_progress"): Promise<any>;
    /** Update session status */
    status(state: string, extra?: {
        task?: string;
        progress?: number;
    }): Promise<any>;
    /** Get all session statuses */
    getAllStatus(): Promise<any>;
    /** Broadcast to all sessions */
    broadcast(content: string, filter?: {
        server?: string;
        status?: string;
    }): Promise<any>;
    private connectSSE;
    private processInbox;
    private sleep;
}
export default CommHub;
