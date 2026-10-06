import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (!existsSync("/.dockerenv") || process.env.TEST658_CONTAINER !== "1") throw Error("container-only mutation");
async function runMutation(label:string,file:string,from:string,to:string) {
  const original=readFileSync(file,"utf8");
  if(!original.includes(from))throw Error(`missing anchor: ${label}`);
  try {
    writeFileSync(file,original.replace(from,to));
    const child=Bun.spawn(["bun","test","tests/test658-codex-adopt-stop/recovery.test.ts"],{stdout:"pipe",stderr:"pipe"});
    const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(rc===0 || !(out+err).includes("(fail)") || !(out+err).includes("expect(received)"))throw Error(`mutation not assertion-red: ${label}\n${out}${err}`);
    console.log(`PASS recovery mutation ${label}: rc=${rc}, assertion red`);
  } finally {writeFileSync(file,original);}
}
await runMutation("delete reason", "agent-node/src/runtime/adopt-lifecycle.ts", 'e?.message === "adopted_node_delete_unsupported" || ', '');
await runMutation("reboot no-signal gate", "agent-node/src/runtime/adopt-lifecycle.ts", 'if (previousBoot) assertCodexAbsentAfterReboot(scope);', 'if (false) assertCodexAbsentAfterReboot(scope);');
await runMutation("concurrent stop receipt", "agent-node/src/runtime/adopt-lifecycle.ts", 'if (stoppedReceipt(stoppedMarker, deps.uid) !== receiptBefore) throw Error("adopt_stop_receipt_changed");', '');
await runMutation("exact resume certificate", "agent-network/src/stopped-receipt.ts", 'data.receipt_fingerprint === fingerprint', 'true');
await runMutation("manual start supersession", "agent-network/src/stopped-receipt.ts", 'renameSync(tmp, file);', '');
