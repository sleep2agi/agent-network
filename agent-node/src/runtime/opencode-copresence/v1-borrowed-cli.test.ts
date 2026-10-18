import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectV1BorrowedCli, V1BorrowedCliError } from "./v1-borrowed-cli";
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"cli1224-")),cwd=join(root,"project"),stateRoot=join(root,"state");
  mkdirSync(cwd,{mode:0o700});mkdirSync(stateRoot,{mode:0o700});
  const host={hostId:"test",instanceId:"a".repeat(32),version:"1.18.1",cohortId:"same"};
  const selection={schema:1,hostRoot:join(root,"host"),expectedHost:host,selectedCohortId:"same",binding:{networkId:"net",nodeId:"node",serverIdentity:`test:${host.instanceId}`,directory:cwd,sessionId:"ses_abc"}};
  const config={token:"synthetic-node-login-1224",runtime:"opencode-cli",opencodeMode:"copresence",network_id:"net",node_id:"node",alias:"alias",model:"fixture/alpha",session:"ses_abc",opencodeBorrowedV1:selection};
  const context={runtime:"opencode",generation:"v1",mode:"copresence",configFile:join(stateRoot,"config.json"),networkId:"net",nodeId:"node",alias:"alias",cwd,stateRoot,model:"fixture/alpha",sessionId:"ses_abc",newSession:false,unsafeTools:false};
  const save=()=>writeFileSync(context.configFile,JSON.stringify(config),{mode:0o600});save();
  return {root,config,context,selection,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
describe("borrowed V1 CLI selection #1224",()=>{
  test("absent selection retains owned path without writing state",()=>{const f=fixture();try{expect(selectV1BorrowedCli(undefined,f.context)).toBeNull();}finally{f.cleanup();}});
  test("private exact selection persists intent and refuses later implicit owned fallback",()=>{const f=fixture();try{const h=selectV1BorrowedCli(f.selection,f.context)!;expect(h.readBinding()).toEqual(f.selection.binding);expect(readFileSync(join(f.context.stateRoot,"opencode-borrowed-v1-selection.json"),"utf8")).toContain('"schema":1');expect(()=>selectV1BorrowedCli(undefined,f.context)).toThrow("no owned fallback");}finally{f.cleanup();}});
  test("live config identity/session/model/generation changes cannot replace frozen binding",()=>{for(const [field,value] of [["network_id","foreign"],["session","ses_other"],["model","fixture/beta"],["opencodeGeneration","v2"],["alias","other"]]){const f=fixture();try{const h=selectV1BorrowedCli(f.selection,f.context)!;(f.config as any)[field]=value;f.save();expect(()=>h.readBinding()).toThrow(V1BorrowedCliError);}finally{f.cleanup();}}});
  test("unselected host incarnation and unrecognised secret fields are refused without echo",()=>{const f=fixture();try{const bad={...f.selection,password:"SECRET_SENTINEL"};let e:any;try{selectV1BorrowedCli(bad,f.context);}catch(error){e=error;}expect(e).toBeInstanceOf(V1BorrowedCliError);expect(e.message).not.toContain("SECRET_SENTINEL");expect(()=>selectV1BorrowedCli({...f.selection,expectedHost:{...f.selection.expectedHost,instanceId:"b".repeat(32)}},f.context)).toThrow("incarnation");}finally{f.cleanup();}});
  test("unsafe/headless/V2/new-session and wrong directory never become borrowed defaults",()=>{const f=fixture();try{for(const patch of [{unsafeTools:true},{mode:"headless"},{generation:"v2"},{newSession:true},{cwd:f.context.stateRoot}])expect(()=>selectV1BorrowedCli(f.selection,{...f.context,...patch})).toThrow();}finally{f.cleanup();}});
});
