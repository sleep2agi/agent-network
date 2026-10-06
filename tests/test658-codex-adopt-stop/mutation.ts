// Container-only, reversible mutations. Never run against a mounted worktree.
import { readFileSync, writeFileSync } from "node:fs";
const cases = [
  ["extra-stage census", "agent-node/src/runtime/adopt-codex-tmux.ts", "  assertNoEscapedCodexProcesses(scope,result);", "  // mutation: census removed"],
  ["partial stop", "agent-node/src/runtime/adopt-codex-stop.ts", "  collectCodexPanes(scope,CODEX_STOP_ORDER,true);", "  collectCodexPanes(scope);"],
  ["stale receipt", "agent-node/src/runtime/adopt-lifecycle.ts", "    await stopCodexStages(scope);", "    if (existsSync(stoppedMarker)) assertCodexStopped(scope);\n    await stopCodexStages(scope);"],
];
for (const [label,file,from,to] of cases) {
  const original=readFileSync(file,"utf8");
  if(!original.includes(from))throw Error(`missing mutation anchor: ${label}`);
  try {
    writeFileSync(file,original.replace(from,to));
    const child=Bun.spawn(["bun","test","./tests/test658-codex-adopt-stop/collect.test.ts"],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(rc===0 || !/\(fail\)/.test(out+err) || !/(expect\(|Expected:)/.test(out+err))throw Error(`mutation did not reach a red assertion: ${label}\n${out}${err}`);
    console.log(`PASS mutation ${label}: rc=${rc}, assertion red`);
  }finally{writeFileSync(file,original);}
}
