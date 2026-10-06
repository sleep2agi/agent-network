import { expect, test } from "bun:test";
import { stopVerifiedTree, type ProcessStamp, type TreeOps } from "./adopt-process-tree.js";
const stamp = (pid: number, ppid: number, birth = String(pid)): ProcessStamp => ({ pid, ppid, birth, uid: 1000 });
test("PID generation mismatch refuses before any signal", async () => {
  const signals: any[] = [];
  const ops: TreeOps = { read: pid => stamp(pid, 1, "reused"), list: () => [10], signal: (...s) => { signals.push(s); }, sleep: async () => {} };
  await expect(stopVerifiedTree(stamp(10, 1), ops)).rejects.toThrow("adopt_process_generation_changed");
  expect(signals).toEqual([]);
});
test("only rooted descendants are signalled, unrelated same-name processes are invisible", async () => {
  const rows = new Map([[10, stamp(10, 1)], [11, stamp(11, 10)], [12, stamp(12, 11)], [20, stamp(20, 1)]]);
  const signals: number[] = [];
  await stopVerifiedTree(rows.get(10)!, { read: p => rows.get(p) ?? null, list: () => [...rows.keys()], sleep: async () => {},
    signal: (p, s) => { signals.push(p); if (s === "SIGTERM") rows.delete(p); } });
  expect(new Set(signals)).toEqual(new Set([10, 11, 12])); expect(rows.has(20)).toBe(true);
});
