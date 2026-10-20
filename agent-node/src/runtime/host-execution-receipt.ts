// Host observations only. Never inspect cmdline, environ, prompts, pane text or logs.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function observeProcess(pid: number | null) {
  const unknown = {pid, state:'unknown' as 'unknown'|'absent'|'present',start_ticks:null as string|null,
    boot_id:null as string|null,executable_sha256:null as string|null};
  if (!Number.isSafeInteger(pid) || pid! <= 0 || process.platform !== 'linux') return unknown;
  try {
    // Read generation before and after hashing: PID reuse cannot create a mixed receipt.
    const generation = () => {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (['Z','X'].includes(fields[0])) throw Object.assign(new Error(),{code:'ESRCH'});
      if (!/^\d+$/.test(fields[19] ?? '')) throw new Error();
      return fields[19];
    };
    const birth = generation();
    const exe = `/proc/${pid}/exe`;
    const before = statSync(exe);
    if (before.size > 128 * 1024 * 1024) return unknown;
    const digest = createHash('sha256').update(readFileSync(exe)).digest('hex');
    const after = statSync(exe);
    if (generation() !== birth || before.ino !== after.ino || before.dev !== after.dev) return unknown;
    const boot = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) return unknown;
    return {pid,state:'present' as const,start_ticks:birth,boot_id:boot,executable_sha256:digest};
  } catch (e:any) { return {...unknown,state:e?.code === 'ENOENT' || e?.code === 'ESRCH' ? 'absent' as const : 'unknown' as const}; }
}
export function executableFingerprint(path: string | undefined): string | null {
  if (!path) return null;
  try { const s=statSync(path); if (!s.isFile() || s.size>128*1024*1024) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}
type Call = (tool:string,args:Record<string,unknown>)=>Promise<any>;
type Context = {requestId:string;nodeId:string;alias:string;operation:'start'|'stop'|'create';
  sessionId?:string|null;pid?:number|null;wrapperPath?:string;enabled?:boolean};
const active = new Map<string,Promise<void>>();
const replies = new Map<string,{tool:string;args:Record<string,unknown>}>();
/** Serializes duplicate doorbells; after a lost ACK, replay the SAME frozen
 * receipt, not another spawn. This cache is not a crash-recovery claim. */
export async function hostCommandOnce(key:string, call:Call, body:()=>Promise<void>):Promise<void> {
  if (active.has(key)) return active.get(key)!;
  const cached = replies.get(key);
  if (cached) { await call(cached.tool,cached.args); return; }
  const work = body(); active.set(key,work);
  try { await work; } finally { active.delete(key); }
}
export function receiptCall(call:Call, context:Context, supported:boolean, observer = observeProcess):Call {
  if (!supported || process.platform !== 'linux') return call;
  return async (tool,args) => {
    const expected = `ack_${context.operation === 'create' ? 'create' : context.operation}_request`;
    if (context.enabled === false) return call(tool,args);
    if (tool !== expected || args.request_id !== context.requestId || args.status === 'starting') return call(tool,args);
    const pid = Number.isSafeInteger(args.child_pid) && Number(args.child_pid)>0 ? Number(args.child_pid) : context.pid ?? null;
    const observed = observer(pid);
    let failure: string|null = args.error === 'execution_outcome_unknown' ? 'execution_outcome_unknown' : args.error === 'legacy_execution_unsupported' ? 'legacy_execution_unsupported'
      : args.status === 'started' || args.status === 'stopped' ? null : 'execution_failed';
    let status = args.status;
    if (status === 'started' && observed.state === 'absent') {
      failure='main_process_not_started';
      status=context.operation === 'create' ? 'failed' : 'start_failed';
    } else if (status === 'started' && observed.state === 'unknown') {
      // Unobservable is NOT a failed launch: marking it stopped could invite a
      // duplicate generation. Retain the old ledger, expose evidence unknown.
      failure='process_evidence_unavailable';
    }
    if (status === 'stopped' && observed.state === 'present') {failure='execution_failed';status='stop_failed';}
    // Keep the caller's specific ledger error; the receipt's bounded failure
    // category is additional evidence, not a replacement for that contract.
    const payload = {...args,status,...(failure ? {error:args.error ?? failure}:{}),execution_receipt:{
      protocol:1,request_id:context.requestId,child_node_id:context.nodeId,child_alias:context.alias,
      operation:context.operation,session_id:context.sessionId ?? null,observed_at:Date.now(),
      process:observed,process_role:pid === null ? 'none' : context.operation === 'stop' ? 'recorded-child' : 'launcher',wrapper_sha256:executableFingerprint(context.wrapperPath),tui_sha256:null,
      consumer_ready:'unknown',failure,
    }};
    // Bound memory; old entries evict, server terminal receipts remain authoritative.
    if (replies.size>=256) replies.delete(replies.keys().next().value!);
    replies.set(context.requestId,{tool,args:payload});
    return call(tool,payload);
  };
}
