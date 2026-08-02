export type ReplyRoute = "send_reply" | "send_task";

export interface CommHubSessionLike {
  alias?: unknown;
}

export interface ReplyRouteCache {
  expiresAt: number;
  aliases: Set<string>;
}

export interface ResolveReplyRouteOptions {
  target: string;
  taskId?: string;
  replyViaSendTask: boolean;
  loadSessions: () => Promise<CommHubSessionLike[] | null | undefined>;
  cache: ReplyRouteCache;
  nowMs?: () => number;
  cacheTtlMs?: number;
}

export function createReplyRouteCache(): ReplyRouteCache {
  return { expiresAt: 0, aliases: new Set() };
}

export function buildCodexAppServerReplyTask(message: string, failed: boolean) {
  return {
    task: failed ? `⚠️ ${message}` : message,
    priority: failed ? "high" : "normal",
  };
}

export async function resolveReplyRoute(options: ResolveReplyRouteOptions): Promise<ReplyRoute> {
  if (!options.replyViaSendTask || !options.taskId) return "send_reply";
  return await isRoutableCommHubSession(options) ? "send_task" : "send_reply";
}

export async function isRoutableCommHubSession(options: Omit<ResolveReplyRouteOptions, "replyViaSendTask" | "taskId">): Promise<boolean> {
  const now = options.nowMs?.() ?? Date.now();
  const ttl = options.cacheTtlMs ?? 3000;
  const target = options.target.trim();
  if (!target) return false;

  if (now < options.cache.expiresAt) {
    return options.cache.aliases.has(target);
  }

  try {
    const sessions = await options.loadSessions();
    if (!Array.isArray(sessions)) {
      options.cache.aliases = new Set();
      options.cache.expiresAt = now + ttl;
      return false;
    }
    options.cache.aliases = new Set(
      sessions
        .map((session) => session?.alias)
        .filter((alias): alias is string => typeof alias === "string" && alias.length > 0),
    );
    options.cache.expiresAt = now + ttl;
    return options.cache.aliases.has(target);
  } catch {
    options.cache.aliases = new Set();
    options.cache.expiresAt = now + ttl;
    return false;
  }
}
