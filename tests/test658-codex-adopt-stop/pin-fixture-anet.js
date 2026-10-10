import { chmodSync, copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetAnetBinAbsForTest } from "../../agent-node/src/runtime/create-node-daemon.js";

const source = join(dirname(fileURLToPath(import.meta.url)), "fixture-anet.js");

let pinTail = Promise.resolve();

/** Point the daemon's trusted anet pin at the container-owned test double.
 * Held until the returned restore runs, so concurrent tests cannot swap the
 * process-global path pin underneath each other.
 * Plain JS: bun 1.3.9's test loader exits 2 if the same helper is a .ts module
 * referenced from start-preflight.test.ts. */
export function pinFixtureAnet(dir) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const wait = pinTail;
  pinTail = gate;
  return wait.then(() => {
    try {
      const pkg = join(dir, "anet-pin");
      const binDir = join(pkg, "bin");
      mkdirSync(binDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({
        name: "@sleep2agi/agent-network",
        bin: { anet: "bin/anet.cjs" },
      }), { mode: 0o644 });
      const bin = join(binDir, "anet.cjs");
      copyFileSync(source, bin);
      chmodSync(bin, 0o755);
      const canonical = realpathSync(bin);
      writeFileSync(join(pkg, "path.conf"), `ANET_BIN_ABS=${canonical}\n`, { mode: 0o600 });
      const previous = {
        ANET_DAEMON_PATH_CONF: process.env.ANET_DAEMON_PATH_CONF,
        ANET_BIN_ABS: process.env.ANET_BIN_ABS,
        ANET_DAEMON_ALLOW_ENV_BIN: process.env.ANET_DAEMON_ALLOW_ENV_BIN,
        ANET_BIN_SHA256: process.env.ANET_BIN_SHA256,
      };
      process.env.ANET_DAEMON_PATH_CONF = join(pkg, "path.conf");
      delete process.env.ANET_BIN_ABS;
      delete process.env.ANET_DAEMON_ALLOW_ENV_BIN;
      delete process.env.ANET_BIN_SHA256;
      _resetAnetBinAbsForTest();
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        _resetAnetBinAbsForTest();
        release();
      };
    } catch (error) {
      release();
      throw error;
    }
  });
}
