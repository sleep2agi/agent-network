// Fake pane root: create a foreign-identity descendant only on the test barrier.
import { existsSync, writeFileSync } from "node:fs";
const dir=process.argv[2];
writeFileSync(`${dir}/ready`, "ready");
const timer=setInterval(()=>{
  if(!existsSync(`${dir}/trigger`))return;
  clearInterval(timer);
  const child=Bun.spawn(["sleep","300"],{env:{...process.env,ANET_NODE_MARKER:"foreign-child"},stdout:"ignore",stderr:"ignore"});
  writeFileSync(`${dir}/child-pid`,String(child.pid));
  child.exited.then(()=>process.exit(0));
},5);
