import { readFileSync, writeFileSync, existsSync } from "node:fs";
if (!existsSync("/.dockerenv")) throw new Error("container only");
if (!["principal", "mcp", "rest", "mcpnode", "restnode"].includes(process.env.MUTATION_CASE ?? "")) {
  throw new Error("unknown mutation case");
}
async function runMutation(name: string, file: string, anchor: string, replacement: string, filter: string, expected: number) {
if (process.env.MUTATION_CASE !== name) return;
const original = readFileSync(file, "utf8");
if (original.split(anchor).length !== 2) throw new Error("mutation anchor must be unique");
try {
  writeFileSync(file, original.replace(anchor, replacement));
  const child = Bun.spawn(["bun", "test", "src/task-sender-http.test.ts", "-t", filter], { stdout: "pipe", stderr: "pipe" });
  const [out, err, rc] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const log = (out + err).replace(/\x1b\[[0-9;]*m/g, "");
  const fails = (log.match(/\(fail\) authenticated sender:/g) ?? []).length;
  if (!rc || !log.includes("expect(received)") || fails !== expected) {
    throw new Error(`mutation did not meet assertion witness: ${name} rc=${rc} fails=${fails}/${expected}\n${log}`);
  }
  console.log(`WITNESSED_RED ${name} assertions=${fails} rc=${rc}`);
} finally { writeFileSync(file, original); }
}

await runMutation("principal", "src/rest-identity.ts",
  "if (requested && requested !== fromSession) {", "if (false) {",
  "authenticated sender: .* rejects another identity without writes", 12);
await runMutation("mcp", "src/tools.ts",
  "const humanSender = !callerTokenIsNetwork && !!enforceUserId;", "const humanSender = false;",
  "authenticated sender: mcp .* rejects another identity without writes", 6);
await runMutation("rest", "src/rest-identity.ts",
  "if (authenticatedUsername) return resolveUserTaskFromSession(authenticatedUsername, input.requestedFrom);",
  "if (false) return resolveUserTaskFromSession(authenticatedUsername, input.requestedFrom);",
  "authenticated sender: rest .* rejects another identity without writes", 6);
await runMutation("mcpnode", "src/tools.ts",
  "const fromNodeId = humanSender ? null : resolveNodeIdForAlias(from_session, effectiveNetId);",
  "const fromNodeId = resolveNodeIdForAlias(from_session, effectiveNetId);",
  "authenticated sender: mcp member uses its username", 1);
await runMutation("restnode", "src/server.ts",
  'const fromNodeId = restAuth && !requestToken(req).startsWith("ntok_")', 'const fromNodeId = false',
  "authenticated sender: rest member uses its username", 1);
