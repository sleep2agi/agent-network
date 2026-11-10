// Fake pane root: create a foreign-identity descendant only on the test barrier.
import { existsSync, renameSync, writeFileSync } from "node:fs";
const dir=process.argv[2];
writeFileSync(`${dir}/ready`, "ready");
const timer=setInterval(()=>{
  if(!existsSync(`${dir}/trigger`))return;
  clearInterval(timer);
  const child=Bun.spawn(["sleep","300"],{env:{...process.env,ANET_NODE_MARKER:"foreign-child"},stdout:"ignore",stderr:"ignore"});
  // 原子发布 PID:先写临时文件再 rename。这样父进程永远看不到"存在但为空"的 child-pid。
  writeFileSync(`${dir}/child-pid.tmp`,String(child.pid));
  renameSync(`${dir}/child-pid.tmp`,`${dir}/child-pid`);
  child.exited.then(()=>process.exit(0));
},5);
