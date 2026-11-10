import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (!existsSync("/.dockerenv")) throw Error("container only");

async function mutate(label: string, from: string, to: string, testName: string) {
  if (process.env.MUTATION_CASE !== label) return;
  const file = "src/tools.ts";
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw Error(`anchor not unique: ${label}`);
  try {
    writeFileSync(file, original.replace(from, to));
    const child = Bun.spawn(["bun", "test", "src/task-late-reply-http.test.ts", "-t", testName], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, rc] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const log = stdout + stderr;
    if (rc === 0 || !log.includes(`(fail) ${testName}`) || !log.includes("expect(received)")) {
      throw Error(`NOT assertion-red ${label}\n${log}`);
    }
    console.log(`WITNESSED_RED ${label} rc=${rc} assertion=${testName}`);
  } finally {
    writeFileSync(file, original);
  }
}

await mutate("executor", "token.bound_node_id !== lateCandidate.to_node_id", "false", "wrong executor, sibling turn, cross-network reader and legacy shape cannot append");
await mutate("turn", "return storedThreadId === threadId && storedTurnId === turnId;", "return true;", "wrong executor, sibling turn, cross-network reader and legacy shape cannot append");
await mutate(
  "terminal",
  "return { ok: true as const, duplicate: false as const, lateReplyId, inboxId: id };",
  `db.run("UPDATE tasks SET status='replied',result=?1 WHERE task_id=?2", [text, in_reply_to]);\n            return { ok: true as const, duplicate: false as const, lateReplyId, inboxId: id };`,
  "exact executor and exact turn append one late receipt without rewriting terminal task",
);
await mutate(
  "duplicate",
  "return { ok: true as const, duplicate: true as const, lateReplyId: existing.late_reply_id, inboxId: existing.inbox_id };",
  "return { ok: true as const, duplicate: false as const, lateReplyId: existing.late_reply_id, inboxId: existing.inbox_id };",
  "exact retry is idempotent and a changed payload conflicts",
);
