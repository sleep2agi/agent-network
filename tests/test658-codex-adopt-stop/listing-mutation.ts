// Container-owned writable copy only. Require the exact disappearance case red.
import { readFileSync, writeFileSync } from "node:fs";
async function runMutation(label: string, file: string, from: string, to: string) {
  const original=readFileSync(file,"utf8");
  if(!original.includes(from))throw Error(`missing mutation anchor: ${label}`);
  try {
    writeFileSync(file,original.replace(from,to));
    const child=Bun.spawn(["bun","test","tests/test658-codex-adopt-stop/listing-race.test.ts"],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(rc===0 || !(out+err).includes("(fail) listing exit race: gone"))throw Error(`mutation missed gone regression: ${label}\n${out}${err}`);
    console.log(`PASS mutation ${label}: rc=${rc}, gone regression red`);
  }finally{writeFileSync(file,original);}
}
await runMutation("server exit recheck", "agent-node/src/runtime/adopt-codex-tmux.ts", 'stderr.trim() === "server exited unexpectedly" && attempt < 2', 'false && attempt < 2');
