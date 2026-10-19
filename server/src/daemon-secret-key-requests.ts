// #1475 — hub-side authorization ledger: which secret keys may a daemon receive.
//
// 为什么是一张独立的表,而不是复用 `nodes.allowed_secret_keys`
// ────────────────────────────────────────────────────────────────
// 那一列**不是授权位,是自述镜像**:
//   · `report_status` 每次心跳都拿 daemon 自报的
//     `config_snapshot.daemon_capabilities.allowed_secret_keys` 覆写
//     `config_snapshot` 和 `allowed_secret_keys` 两处(见 tools.ts 的
//     `UPDATE nodes SET config_snapshot = ?1, runtimes_supported = ?2,
//      allowed_secret_keys = ?3`);
//   · 它唯一被消费的地方是 create_node 的子节点结构校验(`daemonAllowList`,
//     null 即 permissive 不强制);
//   · 密钥下发通道 `scoped-secrets.ts` **根本不读它**。
//
// 两个直接后果,决定了本模块的形状:
//   1. hub 若把审批结果写进那一列,**下一个心跳(3 分钟内)就被 daemon 自述
//      覆写掉**,审批静默失效——测试里跑不出来(测试没有心跳),线上必现;
//   2. 就算写得进去,它也不拦密钥下发,改了等于没改。
//
// 所以授权状态落在 daemon 覆写不到的地方,并把「谁批的、何时、对哪个 daemon、
// 哪个 key」一起留在同一行里当审计。下发侧的强制(读本账本)是**独立的后续切片**,
// 父卡 #1475 首片明写「先只读 + 申请,不做直接授予」——本模块严格停在账本。
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { validScopedSecretKey } from './shared/scoped-secret-contract';

export type SecretKeyRequestAction = 'grant' | 'revoke';
export type SecretKeyRequestStatus = 'pending' | 'approved' | 'rejected';

export interface SecretKeyRequest {
  request_id: string;
  network_id: string;
  daemon_node_id: string;
  key_name: string;
  action: SecretKeyRequestAction;
  status: SecretKeyRequestStatus;
  requested_by: string;
  requested_by_name: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: number | null;
  decide_reason: string | null;
  created_at: number;
  // 决策那一刻 daemon 自述了哪些 key。列本身会被心跳覆写,所以把当时的值
  // 抄一份进审计行——否则日后回看只知道「批了」,不知道当时 daemon 认不认。
  declared_at_decision: string[] | null;
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string; message: string };
type Outcome<T> = Ok<T> | Err;

const fail = (error: string, message: string): Err => ({ ok: false, error, message });

interface DaemonRow {
  node_id: string;
  network_id: string;
  config_snapshot: string | null;
  allowed_secret_keys: string | null;
}

/** 取 daemon 节点;查不到 / 不是 host_supervisor 各给一个可读的错。 */
function resolveDaemon(networkId: string, daemonNodeId: string): { row: DaemonRow } | Err {
  const row = db.get<DaemonRow>(
    `SELECT node_id, network_id, config_snapshot, allowed_secret_keys
       FROM nodes WHERE node_id = ?1 AND network_id = ?2`,
    [daemonNodeId, networkId],
  ) as DaemonRow | undefined;
  if (!row) return fail('daemon_not_found', 'no such node in this network');
  // 与 list_host_supervisors 同一判据:role 在 config_snapshot 里,不是一等列,
  // 且 `node_daemon_` 前缀启发式已被 #338 明确取代——不再按 id 前缀猜。
  let role: unknown = null;
  if (row.config_snapshot) {
    try {
      const snap: unknown = typeof row.config_snapshot === 'string' ? JSON.parse(row.config_snapshot) : row.config_snapshot;
      role = (snap as { role?: unknown } | null)?.role;
    } catch { /* 畸形快照 → role 保持 null → 判为非 daemon */ }
  }
  if (role !== 'host_supervisor') return fail('not_a_daemon', 'target node is not a host_supervisor daemon');
  return { row };
}

function parseDeclared(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : null;
  } catch { return null; }
}

/**
 * 裁决时间戳,**进程内严格递增**。
 *
 * `isKeyAuthorized` 靠 `decided_at` 定先后(批准即改状态,顺序即结果)。
 * 毫秒分辨率下同一次心跳里两次批准会并列 → 排序退化到 `request_id`(随机 UUID)
 * → 撤回还是授权**看运气**。Hub 是单进程,把同毫秒的并列用 +1 抬开即可拿到全序。
 * 批准行永远带 `decided_at`,所以这一列单独就构成全序,不必再依赖其它兜底键。
 */
let lastDecidedAt = 0;
function nextDecidedAt(): number {
  const now = Date.now();
  lastDecidedAt = now > lastDecidedAt ? now : lastDecidedAt + 1;
  return lastDecidedAt;
}

/**
 * 某 (daemon, key) 当前是否**已授权**。
 *
 * 账本单一真源:把所有 approved 行按**批准先后**叠加,最后一行决定状态
 * (grant→已授权,revoke→未授权)。这样审计与状态同源,不必再维护一张会漂移的
 * 授权表——两张表就必然出现「审计说批了、状态说没批」的对不上的那天。
 *
 * 为什么按批准顺序而非申请顺序:两者对冲突单恒等——待批守卫 + 状态门槛把同一
 * (daemon,key) 串行化了,后一张冲突单只有在前一张**批准之后**才建得出来。
 */
export function isKeyAuthorized(networkId: string, daemonNodeId: string, keyName: string): boolean {
  const rows = db.all<{ action: string }>(
    `SELECT action FROM daemon_secret_key_requests
      WHERE network_id = ?1 AND daemon_node_id = ?2 AND key_name = ?3 AND status = 'approved'
      ORDER BY decided_at ASC, request_id ASC`,
    [networkId, daemonNodeId, keyName],
  ) as Array<{ action: string }>;
  if (rows.length === 0) return false;
  return rows[rows.length - 1]!.action === 'grant';
}

function readRow(requestId: string): SecretKeyRequest | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT request_id, network_id, daemon_node_id, key_name, action, status,
            requested_by, requested_by_name, decided_by, decided_by_name,
            decided_at, decide_reason, created_at, declared_at_decision
       FROM daemon_secret_key_requests WHERE request_id = ?1`,
    [requestId],
  );
  if (!row) return null;
  return {
    request_id: String(row.request_id),
    network_id: String(row.network_id),
    daemon_node_id: String(row.daemon_node_id),
    key_name: String(row.key_name),
    action: row.action as SecretKeyRequestAction,
    status: row.status as SecretKeyRequestStatus,
    requested_by: String(row.requested_by ?? ''),
    requested_by_name: String(row.requested_by_name ?? ''),
    decided_by: (row.decided_by as string | null) ?? null,
    decided_by_name: (row.decided_by_name as string | null) ?? null,
    decided_at: (row.decided_at as number | null) ?? null,
    decide_reason: (row.decide_reason as string | null) ?? null,
    created_at: Number(row.created_at ?? 0),
    declared_at_decision: parseDeclared(row.declared_at_decision as string | null),
  };
}

/**
 * 建一条待批申请。
 *
 * 🔴 **不碰 daemon 的任何状态**——`nodes.allowed_secret_keys` 一个字节都不写。
 * 验收第一条「申请单在得到人工批准前,daemon 的 allowed_secret_keys 不得变化」
 * 由**根本不写**来满足,而不是靠小心写对(见文件头:写了也会被心跳覆写)。
 */
export function createSecretKeyRequest(opts: {
  networkId: string;
  daemonNodeId: string;
  keyName: string;
  action: SecretKeyRequestAction;
  requestedBy: string;
  requestedByName: string;
}): Outcome<{ request: SecretKeyRequest }> {
  const keyName = String(opts.keyName ?? '').trim();
  if (!opts.daemonNodeId) return fail('daemon_node_id_required', 'daemon_node_id is required');
  if (opts.action !== 'grant' && opts.action !== 'revoke') {
    return fail('invalid_action', 'action must be grant | revoke');
  }
  // 与密钥下发通道同一个校验器:大写 env 风格、非保留名、不许 COMMHUB_/ANET_/
  // CLAUDE_CODE_ 前缀。申请面与下发面用同一把尺,否则会出现「批得了、发不出」。
  if (!validScopedSecretKey(keyName)) {
    return fail('invalid_key_name', 'key must look like an env var name (A-Z0-9_) and not be reserved');
  }

  const daemon = resolveDaemon(opts.networkId, opts.daemonNodeId);
  if (!('row' in daemon)) return daemon;

  const pending = db.get<{ request_id: string }>(
    `SELECT request_id FROM daemon_secret_key_requests
      WHERE network_id = ?1 AND daemon_node_id = ?2 AND key_name = ?3 AND action = ?4 AND status = 'pending'`,
    [opts.networkId, opts.daemonNodeId, keyName, opts.action],
  );
  if (pending) return fail('request_already_pending', `a pending ${opts.action} for this key already exists`);

  // 状态没变就无事可申请:重复 grant 已授权的、撤销没授权的,批准了也是空操作,
  // 留在账本里只会把审计读成「有过分歧」。**在申请时**判(不是批准时),
  // 让申请人在自己那一步就看到真实状态。
  const authorized = isKeyAuthorized(opts.networkId, opts.daemonNodeId, keyName);
  if (opts.action === 'grant' && authorized) return fail('key_already_authorized', 'this key is already authorized for this daemon');
  if (opts.action === 'revoke' && !authorized) return fail('key_not_authorized', 'this key is not authorized for this daemon');

  const requestId = `skar_${randomUUID()}`;
  const now = Date.now();
  db.run(
    `INSERT INTO daemon_secret_key_requests
       (request_id, network_id, daemon_node_id, key_name, action, status,
        requested_by, requested_by_name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)`,
    [requestId, opts.networkId, opts.daemonNodeId, keyName, opts.action, opts.requestedBy, opts.requestedByName, now],
  );

  const request = readRow(requestId);
  if (!request) return fail('internal_error', 'request row disappeared right after insert');
  return { ok: true, request };
}

/**
 * 人工裁决。
 *
 * 🔴 「人批,不让 agent 自授」的闸在 HTTP 层(`userTokenRequired` 拒网络绑定的
 * 节点 token),本函数再要求调用方给出**人类身份**;两层都要过,少一层都不算数。
 *
 * 批准时**重新读一次状态**:create 到 decide 之间 daemon 可能报了新的自述、
 * 或另一单已把状态翻过去。状态不再匹配就返回 `state_changed` 并**保持 pending**
 * ——不替批准人做决定,让他自己看见分歧后选 reject。
 */
export function decideSecretKeyRequest(opts: {
  networkId: string;
  requestId: string;
  decision: 'approve' | 'reject';
  decidedBy: string;
  decidedByName: string;
  reason?: string | null;
}): Outcome<{ request: SecretKeyRequest }> {
  if (opts.decision !== 'approve' && opts.decision !== 'reject') {
    return fail('invalid_decision', 'decision must be approve | reject');
  }
  const existing = readRow(opts.requestId);
  if (!existing || existing.network_id !== opts.networkId) {
    return fail('request_not_found', 'no such request in this network');
  }
  if (existing.status !== 'pending') {
    // 幂等重放给同一个可读错,而不是让第二次批准把第一次的 decided_by 覆掉。
    return fail('request_already_decided', `request is already ${existing.status}`);
  }

  const now = nextDecidedAt();

  if (opts.decision === 'approve') {
    const daemon = resolveDaemon(opts.networkId, existing.daemon_node_id);
    if (!('row' in daemon)) {
      // daemon 被删了 —— 这单不可能再生效,但**不替批准人关单**:
      // 409 + 保持 pending,让他 reject 时写清原因。
      return fail('state_changed', 'the target daemon no longer exists in this network; reject the request instead');
    }
    const authorized = isKeyAuthorized(opts.networkId, existing.daemon_node_id, existing.key_name);
    // 裁决前该是**什么状态**才说明这单还没被别人办过:
    //   grant  → 事前应当「未授权」(批准=把它授上)
    //   revoke → 事前应当「已授权」(批准=把它撤下)
    // 找不到这个事前状态,就说明 create 到 decide 之间被别人翻过,判分歧。
    const preAuthorized = existing.action === "revoke";
    if (authorized !== preAuthorized) {
      return fail(
        'state_changed',
        `authorization state moved since this request was filed (now ${authorized ? 'authorized' : 'not authorized'}); reject the request instead`,
      );
    }
    db.run(
      `UPDATE daemon_secret_key_requests
          SET status = 'approved', decided_by = ?1, decided_by_name = ?2, decided_at = ?3,
              decide_reason = ?4, declared_at_decision = ?5
        WHERE request_id = ?6 AND status = 'pending'`,
      [opts.decidedBy, opts.decidedByName, now, opts.reason ?? null, JSON.stringify(parseDeclared(daemon.row.allowed_secret_keys)), existing.request_id],
    );
  } else {
    db.run(
      `UPDATE daemon_secret_key_requests
          SET status = 'rejected', decided_by = ?1, decided_by_name = ?2, decided_at = ?3, decide_reason = ?4
        WHERE request_id = ?5 AND status = 'pending'`,
      [opts.decidedBy, opts.decidedByName, now, opts.reason ?? null, existing.request_id],
    );
  }

  const request = readRow(existing.request_id);
  if (!request) return fail('internal_error', 'request row disappeared during decision');
  return { ok: true, request };
}

/** 审计回读:按 daemon / key 名 / 状态过滤。 */
export function listSecretKeyRequests(opts: {
  networkId: string;
  daemonNodeId?: string | null;
  keyName?: string | null;
  status?: SecretKeyRequestStatus | null;
  limit?: number;
}): Outcome<{ rows: SecretKeyRequest[] }> {
  const params: unknown[] = [opts.networkId];
  let sql = `SELECT request_id, network_id, daemon_node_id, key_name, action, status,
                    requested_by, requested_by_name, decided_by, decided_by_name,
                    decided_at, decide_reason, created_at, declared_at_decision
               FROM daemon_secret_key_requests WHERE network_id = ?1`;
  if (opts.daemonNodeId) { params.push(opts.daemonNodeId); sql += ` AND daemon_node_id = ?${params.length}`; }
  if (opts.keyName) { params.push(opts.keyName); sql += ` AND key_name = ?${params.length}`; }
  if (opts.status) { params.push(opts.status); sql += ` AND status = ?${params.length}`; }
  sql += ` ORDER BY created_at DESC, request_id DESC LIMIT ?${params.length + 1}`;
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));

  const rows = db.all<Record<string, unknown>>(sql, params as never);
  return {
    ok: true,
    rows: rows.map(row => ({
      request_id: String(row.request_id),
      network_id: String(row.network_id),
      daemon_node_id: String(row.daemon_node_id),
      key_name: String(row.key_name),
      action: row.action as SecretKeyRequestAction,
      status: row.status as SecretKeyRequestStatus,
      requested_by: String(row.requested_by ?? ''),
      requested_by_name: String(row.requested_by_name ?? ''),
      decided_by: (row.decided_by as string | null) ?? null,
      decided_by_name: (row.decided_by_name as string | null) ?? null,
      decided_at: (row.decided_at as number | null) ?? null,
      decide_reason: (row.decide_reason as string | null) ?? null,
      created_at: Number(row.created_at ?? 0),
      declared_at_decision: parseDeclared(row.declared_at_decision as string | null),
    })),
  };
}
