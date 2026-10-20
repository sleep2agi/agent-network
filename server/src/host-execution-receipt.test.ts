import {describe,expect,test} from 'bun:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {observeProcess,executableFingerprint,receiptCall,hostCommandOnce} from '../../agent-node/src/runtime/host-execution-receipt.js';
import {executionReceiptSchema} from './host-execution-receipt.js';

const ctx={requestId:'str_local',nodeId:'node_local',alias:'local',operation:'start' as const,sessionId:'synthetic-session',wrapperPath:'/bin/sleep'};
describe('real Linux process observations, no argv/env/pane/log access',()=>{
 test('live owned process has exact generation/executable fingerprint, death becomes absent',async()=>{
   const child=spawn('/bin/sleep',['20'],{stdio:'ignore'});
   try {
     const live=observeProcess(child.pid!);
     expect(live.state).toBe('present'); expect(live.pid).toBe(child.pid!);
     expect(live.start_ticks).toMatch(/^\d+$/);expect(live.boot_id).toMatch(/^[a-f0-9-]{36}$/);
     expect(live.executable_sha256).toBe(executableFingerprint('/bin/sleep'));
   } finally {const done=once(child,'exit');child.kill();await done;}
   expect(observeProcess(child.pid!).state).toBe('absent');
 });
 test('null / invalid PID never becomes process-running',()=>{
   expect(observeProcess(null).state).toBe('unknown');expect(observeProcess(-1).state).toBe('unknown');
 });
 test('real exited launcher cannot produce started; fixed error, no exception/body copied',async()=>{
   const child=spawn('/bin/true',[],{stdio:'ignore'});await once(child,'exit');
   let sent:any;const call=receiptCall(async(_t,args)=>{sent=args;return{ok:true};}, {...ctx,requestId:'str_dead'},true);
   await call('ack_start_request',{request_id:'str_dead',status:'started',child_pid:child.pid});
   expect(sent.status).toBe('start_failed');expect(sent.error).toBe('main_process_not_started');
   expect(sent.execution_receipt.process.state).toBe('absent');
   expect(sent.execution_receipt.consumer_ready).toBe('unknown');expect(executionReceiptSchema.safeParse(sent.execution_receipt).success).toBe(true);
 });
 test('observer fault stays unknown rather than claiming failed/stopped launch',async()=>{
   let sent:any;const call=receiptCall(async(_t,args)=>{sent=args;return{ok:true};},{...ctx,requestId:'str_observer_fault'},true,
     pid=>({...observeProcess(null),pid}));
   await call('ack_start_request',{request_id:'str_observer_fault',status:'started',child_pid:123});
   expect(sent.status).toBe('started');expect(sent.execution_receipt.process.state).toBe('unknown');
   expect(sent.execution_receipt.failure).toBe('process_evidence_unavailable');expect(sent.execution_receipt.consumer_ready).toBe('unknown');
 });
 for (const [i, error] of ['workdir_is_home','workdir_has_other_node:child-default','workdir_is_system_dir','workdir_not_ascii','not_my_child'].entries()) {
  test(`receipt preserves specific terminal error ${error}`,async()=>{
   const operation=i===4?'stop' as const:'create' as const;
   const status=operation==='stop'?'stop_failed':'rejected';
   const requestId=`${operation==='stop'?'sr':'cr'}_preserve_${i}`;
   let sent:any;
   const call=receiptCall(async(_t,args)=>{sent=args;return{ok:true};},{...ctx,operation,requestId},true);
   await call(`ack_${operation}_request`,{request_id:requestId,status,error});
   expect(sent.status).toBe(status);expect(sent.error).toBe(error);
   expect(sent.execution_receipt.failure).toBe('execution_failed');
   expect(executionReceiptSchema.safeParse(sent.execution_receipt).success).toBe(true);
  });
 }
 test('generic terminal error only fills an absent error while receipt remains bounded',async()=>{
  for (const [i,error] of [undefined,null].entries()) {
   const requestId=`sr_fallback_${i}`;let sent:any;
   const call=receiptCall(async(_t,args)=>{sent=args;return{ok:true};},{...ctx,operation:'stop',requestId},true);
   await call('ack_stop_request',{request_id:requestId,status:'stop_failed',error});
   expect(sent.status).toBe('stop_failed');expect(sent.error).toBe('execution_failed');
   expect(sent.execution_receipt.failure).toBe('execution_failed');
  }
 });
 test('old Hub receives its original ACK shape',async()=>{
   let sent:any;const call=receiptCall(async(_t,args)=>{sent=args;return{};},ctx,false);
   await call('ack_start_request',{request_id:ctx.requestId,status:'start_failed',error:'synthetic'});
   expect(sent).toEqual({request_id:ctx.requestId,status:'start_failed',error:'synthetic'});
 });
 test('duplicate concurrent command runs once; lost ACK replays byte-identical receipt',async()=>{
   const requestId='str_once';let executions=0,calls:any[]=[];
   const hub=async(_t:string,args:any)=>{calls.push(args);if(calls.length===1)throw Error('synthetic lost ACK');return{ok:true};};
   const wrapped=receiptCall(hub,{...ctx,requestId},true);
   const body=async()=>{executions++;await new Promise(r=>setTimeout(r,10));await wrapped('ack_start_request',{request_id:requestId,status:'start_failed',error:'legacy_execution_unsupported'}).catch(()=>{});};
   await Promise.all([hostCommandOnce(requestId,hub,body),hostCommandOnce(requestId,hub,body)]);
   await hostCommandOnce(requestId,hub,body);
   expect(executions).toBe(1);expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);
 });
 test('strict shape rejects payload/unknown phases, consumption claims and invalid failure codes',()=>{
   const fake={protocol:1,request_id:'str_x',child_node_id:'node_x',child_alias:'x',operation:'start',session_id:null,
     observed_at:1,process:observeProcess(null),process_role:'none',wrapper_sha256:null,tui_sha256:null,consumer_ready:'unknown',failure:'execution_failed'};
   expect(executionReceiptSchema.safeParse(fake).success).toBe(true);
   for(const extra of [{env:'synthetic-sentinel'},{consumer_ready:true},{failure:'any private text'},{prompt:'synthetic'}])expect(executionReceiptSchema.safeParse({...fake,...extra}).success).toBe(false);
 });
});
