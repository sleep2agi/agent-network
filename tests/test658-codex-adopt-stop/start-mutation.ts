// Container-owned writable source only; never mount the host worktree here.
import { readFileSync, writeFileSync } from "node:fs";
async function runMutation(label: string, file: string, from: string, to: string) {
  const original=readFileSync(file,"utf8");
  if(!original.includes(from))throw Error(`missing mutation anchor: ${label}`);
  try {
    writeFileSync(file,original.replace(from,to));
    const child=Bun.spawn(["bun","test","./agent-node/src/runtime/adopt-codex-start-inputs.test.ts","./tests/test658-codex-adopt-stop/start-preflight.test.ts"],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(rc===0 || !/\(fail\)/.test(out+err) || !/(expect\(|Expected:)/.test(out+err))throw Error(`mutation missed assertion: ${label}\n${out}${err}`);
    console.log(`PASS mutation ${label}: rc=${rc}, assertion red`);
  } finally {writeFileSync(file,original);}
}
await runMutation("binding generation", "agent-node/src/runtime/adopt-codex-start-preflight.ts", "  if (authorityRequestId !== entry.request_id) throw Error(\"adopt_codex_binding_generation_unproven\");", "  // mutation: authority check removed");
await runMutation("receipt tampering", "agent-node/src/runtime/adopt-codex-start-inputs.ts", "  if (!isDeepStrictEqual(saved, current)) throw Error(\"adopt_codex_start_evidence_changed\");", "  // mutation: saved inputs ignored");
await runMutation("no live stages", "agent-node/src/runtime/adopt-codex-start-preflight.ts", "  assertCodexStopped(scope);", "  // mutation: liveness check removed");
await runMutation("project permission", "agent-node/src/runtime/adopt-codex-start-inputs.ts", " || (st.mode & 0o022)", "");
await runMutation("project owner", "agent-node/src/runtime/adopt-codex-start-inputs.ts", " || st.uid !== scope.uid", "");
