import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { codexStartInputs, optionalCodexStartInputs, verifyCodexStartInputs } from "./adopt-codex-start-inputs.js";

const thread = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const workdir = mkdtempSync("/tmp/start-inputs-");
  const identity = {workdir, nodeDir:`${workdir}/node`, configPath:`${workdir}/node/config.json`, nodeId:"n_fixture", alias:"样例",
    config:{codexThreadId:thread,codexAppServerUrl:"ws://127.0.0.1:49101", token:"must-not-copy"} as Record<string,unknown>};
  const scope = {layout:"native" as const, alias:identity.alias, socket:`${workdir}/socket`, marker:thread,
    codexHome:`${identity.nodeDir}/codex-home`,workdir,uid:process.getuid!()};
  return {identity,scope};
}
test("start inputs: exact thread, both layouts, no copied token or commands", () => {
  for (const layout of ["native","external-appserver"] as const) {
    const {identity,scope} = fixture();
    const inputs = codexStartInputs(identity,{...scope,layout},"adopt_one");
    expect(inputs.scope.layout).toBe(layout);
    expect(inputs.thread_id).toBe(thread);
    expect(inputs.project_dir).toBe(identity.workdir);
    expect(JSON.stringify(inputs)).not.toContain("must-not-copy");
    expect(verifyCodexStartInputs(inputs,identity,{...scope,layout},"adopt_one")).toEqual(inputs);
  }
});
test("start inputs: never accept a prefix or invent a thread", () => {
  const {identity,scope} = fixture();
  for (const bad of [undefined,"",thread.slice(0,8),`${thread}suffix`,` ${thread}`,42]) {
    identity.config.codexThreadId=bad;
    expect(()=>codexStartInputs(identity,scope,"adopt_one")).toThrow("adopt_codex_exact_thread_required");
    expect(optionalCodexStartInputs(identity,scope,"adopt_one")).toBeUndefined();
  }
});
test("start inputs: reject remote, credential-bearing and implicit endpoints", () => {
  const {identity,scope} = fixture();
  for (const bad of [undefined,"ws://localhost:1234","ws://192.0.2.1:1234","ws://user:secret@127.0.0.1:1234","ws://127.0.0.1",
    "ws://127.0.0.1:0","ws://127.0.0.1:65536","ws://127.0.0.1:1234/?token=secret","ws://127.0.0.1:1234/path","http://127.0.0.1:1234"]) {
    identity.config.codexAppServerUrl=bad;
    expect(()=>codexStartInputs(identity,scope,"adopt_one")).toThrow("adopt_codex_local_endpoint_required");
  }
  identity.config.codexAppServerUrl="ws://[::1]:1234";
  expect(codexStartInputs(identity,scope,"adopt_one").appserver_url).toBe("ws://[::1]:1234");
});
test("start inputs: project/home must match verified canonical scope", () => {
  const {identity,scope} = fixture();
  mkdirSync(`${identity.workdir}/project`,{mode:0o700});
  symlinkSync(`${identity.workdir}/project`,`${identity.workdir}/link`);
  for (const bad of ["/tmp","relative",`${identity.workdir}/link`,`${identity.workdir}/project/../project`]) {
    identity.config.codexProjectDir=bad;
    expect(()=>codexStartInputs(identity,scope,"adopt_one")).toThrow("adopt_codex_project_unproven");
  }
  identity.config.codexProjectDir=`${identity.workdir}/project`;
  expect(codexStartInputs(identity,scope,"adopt_one").project_dir).toBe(identity.config.codexProjectDir);
  identity.config.env={CODEX_HOME:"/other"};
  expect(()=>codexStartInputs(identity,scope,"adopt_one")).toThrow("adopt_codex_home_unproven");
});
test("start inputs: receipt is tied to every identity/config field and binding generation", () => {
  const {identity,scope} = fixture();
  const saved = codexStartInputs(identity,scope,"adopt_one");
  for (const replacement of [{...saved,version:2},{...saved,thread_id:thread.slice(0,8)},{...saved,binding_request_id:"adopt_old"},
    {...saved,node_id:"n_other"},{...saved,scope:{...scope,marker:"other"}}])
    expect(()=>verifyCodexStartInputs(replacement,identity,scope,"adopt_one")).toThrow("adopt_codex_start_evidence_changed");
  identity.config.token="rotated";
  expect(()=>verifyCodexStartInputs(saved,identity,scope,"adopt_one")).toThrow("adopt_codex_start_evidence_changed");
  expect(()=>verifyCodexStartInputs(undefined,identity,scope,"adopt_one")).toThrow("adopt_codex_start_evidence_missing");
});
