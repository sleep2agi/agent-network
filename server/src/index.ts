// Run-entry shim (#438 corrective, 方案 C per 通信龙).
//
// Running this module IS running the hub: `bun run src/index.ts` keeps
// working for the 50+ e2e/dev scripts that boot the hub that way. All
// real code lives in ./server.ts, which is side-effect-free to import —
// tests and tooling import "./server.js" and get bootServer/startHub
// without binding any port. Do NOT add logic here, and do NOT import
// this module to "get at the server" — that starts one.
import { startHub } from "./server.js";

startHub();
