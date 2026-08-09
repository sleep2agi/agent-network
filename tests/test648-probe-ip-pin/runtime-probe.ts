import { safelyFetchProbe } from "../../agent-node/src/runtime/probe-daemon.js";

let resolveCalls = 0;
const result = await safelyFetchProbe(
  "anthropic",
  "https://api.anthropic.com:18443",
  "claude-pin-test",
  "sk-test648-not-secret",
  { ...process.env, ANET_DAEMON_PROBE_ALLOW_LOOPBACK: "1" },
  async (hostname) => {
    resolveCalls++;
    if (hostname !== "api.anthropic.com") throw new Error(`unexpected_host:${hostname}`);
    // The pre-validation answer is 127.0.0.1. /etc/hosts deliberately points
    // the same hostname at 127.0.0.2, so a second/system lookup reaches the
    // rebound server. Only a real connector pin reaches the validated server.
    return [{ address: "127.0.0.1", family: 4 }];
  },
);

if (resolveCalls !== 1) {
  console.error(`PIN_FAIL resolver_calls=${resolveCalls}`);
  process.exit(2);
}
if (result.errorKind !== null || result.resp?.status !== 200) {
  console.error(`PIN_FAIL error=${result.errorKind} status=${result.resp?.status ?? "none"} detail=${result.errorDetail ?? ""}`);
  process.exit(3);
}
console.log(`PIN_OK runtime=${typeof Bun === "undefined" ? "node" : "bun"} status=200 resolver_calls=1`);
process.exit(0);
