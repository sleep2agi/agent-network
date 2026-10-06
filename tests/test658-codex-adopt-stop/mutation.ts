// Container-only, reversible mutations. Never run against a mounted worktree.
import { readFileSync, writeFileSync } from "node:fs";
async function runMutation(label: string, file: string, from: string, to: string) {
  const original=readFileSync(file,"utf8");
  if(!original.includes(from))throw Error(`missing mutation anchor: ${label}`);
  try {
    writeFileSync(file,original.replace(from,to));
    const child=Bun.spawn(["bun","test","./tests/test658-codex-adopt-stop/collect.test.ts"],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(rc===0 || !/\(fail\)/.test(out+err) || !/(expect\(|Expected:)/.test(out+err))throw Error(`mutation did not reach a red assertion: ${label}\n${out}${err}`);
    if(label==="final liveness" && !(out+err).includes("(fail) signal boundary: late-escape"))throw Error("final liveness mutation missed its race assertion");
    if(label==="signal marker" && !(out+err).includes("(fail) signal boundary: late-foreign-child"))throw Error("marker mutation missed its race assertion");
    console.log(`PASS mutation ${label}: rc=${rc}, assertion red`);
    for(const line of (out+err).split("\n"))if(line.startsWith("(fail)"))console.log(`  ${line}`);
  }finally{writeFileSync(file,original);}
}
await runMutation("extra-stage census", "agent-node/src/runtime/adopt-codex-tmux.ts", "  assertNoEscapedCodexProcesses(scope,result);", "  // mutation: census removed");
await runMutation("partial stop", "agent-node/src/runtime/adopt-codex-stop.ts", "  collectCodexPanes(scope,CODEX_STOP_ORDER,true);", "  collectCodexPanes(scope);");
await runMutation("stale receipt", "agent-node/src/runtime/adopt-lifecycle.ts", "    await stopCodexStages(scope);", "    if (existsSync(stoppedMarker)) assertCodexStopped(scope);\n    await stopCodexStages(scope);");
await runMutation("raw marker prefilter", "agent-node/src/runtime/adopt-proc.ts", "export function hasAdoptionMarker(pid: number, marker: string): boolean {", "export function hasAdoptionMarker(pid: number, marker: string): boolean { return true;");
await runMutation("final liveness", "agent-node/src/runtime/adopt-codex-stop.ts", "export function assertCodexStopped(scope: CodexAdoptionScope): void {", "export function assertCodexStopped(scope: CodexAdoptionScope): void { return;");
await runMutation("signal marker", "agent-node/src/runtime/adopt-codex-stop.ts", "proc.env.ANET_NODE_MARKER !== scope.marker || ", "");
