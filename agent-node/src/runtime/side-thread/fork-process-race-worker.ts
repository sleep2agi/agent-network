import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerSideThreadAdapter } from "./codex-app-server-adapter";
import { PrivateFileOperationLedger } from "./operation-ledger";
import { PrivateFileForkLeaseStore } from "./fork-lease";

const [shared, worker] = process.argv.slice(2);
mkdirSync(shared, { recursive: true });

class BarrierClient extends EventEmitter {
  async request<T>(method: string): Promise<T> {
    if (method === "thread/list") {
      writeFileSync(join(shared, `list-ready-${worker}`), "1", { flag: "wx" });
      const deadline = Date.now() + 5_000;
      while (readdirSync(shared).filter((name) => name.startsWith("list-ready-")).length < 2
        && !readdirSync(shared).some((name) => name.startsWith("claim-refused-"))) {
        if (Date.now() > deadline) throw new Error("fork race barrier timed out");
        await Bun.sleep(1);
      }
      return { data: [{ id: "main", turns: [] }], nextCursor: null } as T;
    }
    if (method === "thread/fork") {
      writeFileSync(join(shared, `fork-rpc-${worker}`), "1", { flag: "wx" });
      return { thread: { id: `fork-${worker}`, forkedFromId: "main", turns: [] } } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

const adapter = new CodexAppServerSideThreadAdapter({
  client: new BarrierClient(), runtimeVersion: "0.148.0", topology: "owned-stdio",
  evidenceRevision: "test1190-wire-v2", experimentalApi: true, nodeId: "node-1",
  operationLedger: new PrivateFileOperationLedger(join(shared, "operations")),
  forkLeaseStore: new PrivateFileForkLeaseStore(join(shared, "leases")),
});

try {
  const result = await adapter.fork({ sideThreadId: "same-side", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
  writeFileSync(join(shared, `result-${worker}`), JSON.stringify({ ok: true, result }));
} catch (error) {
  if (String(error).includes("already executing")) writeFileSync(join(shared, `claim-refused-${worker}`), "1");
  writeFileSync(join(shared, `result-${worker}`), JSON.stringify({ ok: false, error: String(error) }));
}
