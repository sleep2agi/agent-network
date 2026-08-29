// #1448 — SSE 重连/boot 补偿：stop/delete/start 门铃。
//
// hub 的 pushEvent 是纯内存 fan-out：派发 stop/start 门铃那刻若本 daemon 没有
// live SSE 订阅者(hub 重启 / 网络抖 / daemon boot 的 ~3s 窗口)就静默丢弃、不入队。
// 于是 node_stop_requests / node_start_requests 的行永远停在 pending、hub 侧节点
// 卡死 stopping/deleting/starting——delete 有 #1286 的 5min force 逃生，stop/start
// 连那个都没有。
//
// create 早有对称保护(reconcilePendingCreateRequestsOnConnect + hub
// list_my_pending_create_requests，#1394)；本模块把同一套补偿镜像到
// stop/delete/start：每次 SSE connected 时拉一遍本 daemon 名下的 pending 生命周期
// 请求，逐条重放对应的门铃 handler(handleStopDoorbell / handleStartDoorbell)。
//
// handler 走注入而非直接 import：① 与 create 的做法一致(它注入
// handleCreateNodeDoorbell)；② 避免本模块耦合 stop-daemon + start-daemon 两个
// 运行时；③ 单测可注入假 handler 直接验重放/去重逻辑。
//
// 幂等由两层保证：hub 只返回 status='pending' 的行——handler 一旦 pull
// (get_stop_request/get_start_request 把行标 delivered)该行就不再被列出；再叠一层
// recentlyHandled 去重集合(与 live 门铃 handler 共享)防「重连 reconcile 与残留 live
// 门铃同时处理同一行」的竞态。

export interface ReconcilePendingLifecycleDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  // 与 live stop/start 门铃 handler 共享的去重集合，避免同一 request 被
  // 重连补偿和残留 live 门铃各处理一次。可选：不传则仅靠 hub 的 pending 过滤。
  recentlyHandledStopRequestIds?: Set<string>;
  recentlyHandledStartRequestIds?: Set<string>;
  // 注入的门铃 handler。cli 在挂载处用真实 deps 包好 handleStopDoorbell /
  // handleStartDoorbell 再传进来。
  handleStopDoorbell: (event: { request_id: string }) => Promise<void>;
  handleStartDoorbell: (event: { request_id: string }) => Promise<void>;
}

interface ListPendingLifecycleResult {
  ok?: boolean;
  error?: string;
  stop_requests?: Array<{ request_id?: string }>;
  start_requests?: Array<{ request_id?: string }>;
}

async function replayEach(
  rows: Array<{ request_id?: string }>,
  seen: Set<string> | undefined,
  handle: (event: { request_id: string }) => Promise<void>,
  warn: (m: string) => void,
  label: string,
): Promise<number> {
  let handled = 0;
  for (const row of rows) {
    const requestId = typeof row?.request_id === "string" ? row.request_id : "";
    if (!requestId) continue;
    if (seen?.has(requestId)) continue;
    seen?.add(requestId);
    try {
      await handle({ request_id: requestId });
      handled += 1;
    } catch (e: any) {
      // 失败就从去重集合里放回来，下一次 connected 还能重试(与 create 一致)。
      seen?.delete(requestId);
      warn(`[lifecycle] pending ${label} reconcile handler failed for ${requestId}: ${e?.message || e}`);
    }
  }
  return handled;
}

export async function reconcilePendingLifecycleRequestsOnConnect(
  deps: ReconcilePendingLifecycleDeps,
): Promise<void> {
  const res: ListPendingLifecycleResult = await deps.callCommHub("list_my_pending_lifecycle_requests", {});
  if (!res?.ok) {
    deps.warn(`[lifecycle] pending reconcile failed: ${res?.error || "unknown"}`);
    return;
  }
  const stops = Array.isArray(res.stop_requests) ? res.stop_requests : [];
  const starts = Array.isArray(res.start_requests) ? res.start_requests : [];

  const handledStop = await replayEach(stops, deps.recentlyHandledStopRequestIds, deps.handleStopDoorbell, deps.warn, "stop/delete");
  const handledStart = await replayEach(starts, deps.recentlyHandledStartRequestIds, deps.handleStartDoorbell, deps.warn, "start");

  const total = handledStop + handledStart;
  if (total > 0) {
    deps.log(`[lifecycle] pending reconcile handled ${total} request(s) (stop/delete=${handledStop}, start=${handledStart})`);
  }
}
