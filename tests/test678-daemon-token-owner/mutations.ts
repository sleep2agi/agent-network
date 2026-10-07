import { readFileSync, writeFileSync, existsSync } from "node:fs";
if (!existsSync("/.dockerenv")) throw Error("container only");
async function runMutation(label: string, file: string, from: string, to: string, testName: string) {
  if (process.env.MUTATION_CASE !== label) return;
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw Error(`anchor not unique: ${label}`);
  try {
    writeFileSync(file, original.replace(from, to));
    const process_ = Bun.spawn(["bun", "test", "src/daemon-token-owner-http.test.ts", "-t", testName], { stdout: "pipe", stderr: "pipe" });
    const [out, err, rc] = await Promise.all([new Response(process_.stdout).text(), new Response(process_.stderr).text(), process_.exited]);
    if (!rc || !(out + err).includes(`(fail) ${testName}`) || !(out + err).includes("expect(received)")) throw Error(`NOT assertion-red ${label}\n${out}${err}`);
    if (label === "resolver" && ((out + err).match(/\(fail\) daemon identity boundary:/g) || []).length !== 13) throw Error(`not all 13 identity boundaries witnessed red\n${out}${err}`);
    console.log(`WITNESSED_RED ${label} rc=${rc} assertion=${testName}`);
  } finally { writeFileSync(file, original); }
}
await runMutation("resolver", "src/create-node.ts", 'if (!ownsNode && !boundToNode && !legacyOwnerless) return { ok: false, reason: "not_owner" };', '', 'daemon identity boundary:');
await runMutation("mint", "src/auth.ts", 'nodeId = checkNodeTokenClaim(userId, networkId, nodeName, nodeId);', '', 'name-only issuance checks existing ownership atomically');
await runMutation("legacy", "src/create-node.ts", 'const ownsNode = !!tokRow.user_id && tokRow.user_id === nodeRow.owner_user_id;', 'const ownsNode = false;', 'legacy owner and exact bound identity remain supported');
await runMutation("bound", "src/create-node.ts", 'const boundToNode = tokRow.bound_node_id === nodeRow.node_id;', 'const boundToNode = false;', 'legacy owner and exact bound identity remain supported');
await runMutation("ownerless", "src/create-node.ts", 'const legacyOwnerless = nodeRow.owner_user_id === null && tokRow.node_identity_epoch === 0;', 'const legacyOwnerless = false;', 'ownerless legacy daemon remains supported without rewriting its owner');
await runMutation("epoch", "src/create-node.ts", 'const legacyOwnerless = nodeRow.owner_user_id === null && tokRow.node_identity_epoch === 0;', 'const legacyOwnerless = nodeRow.owner_user_id === null;', 'daemon identity boundary:');
await runMutation("refresh", "src/node-token-ownership.ts", 'export function legacyNodeHolder(user: string, network: string, alias: string, nodeId: string): boolean {', 'export function legacyNodeHolder(user: string, network: string, alias: string, nodeId: string): boolean { return false;', 'ownerless legacy daemon remains supported without rewriting its owner');
await runMutation("freshid", "src/auth.ts", 'nodeId = checkNodeTokenClaim(userId, networkId, nodeName, nodeId);', 'nodeId = nodeId ?? checkNodeTokenClaim(userId, networkId, nodeName);', 'fresh ID cannot mint another node alias');
await runMutation("boundlookup", "src/create-node.ts", 'const rows = tokRow.bound_node_id', 'const rows = false', 'duplicate legacy aliases use bound IDs and an unbound token follows its owner');
await runMutation("ambiguous", "src/create-node.ts", `  const nodeRow = rows.length === 1
    ? rows[0]
    : (!tokRow.bound_node_id && rows.length > 1
      ? disambiguateUnboundAlias(rows, tokRow.user_id, tokenAlias, tokRow.network_id)
      : undefined);`, 'const nodeRow = rows[0];', 'duplicate legacy aliases use bound IDs and an unbound token follows its owner');
await runMutation("registration", "src/tools.ts", 'WHERE token_id=?2 AND node_identity_epoch=2 AND bound_node_id IS NULL', 'WHERE token_id=?2 AND node_identity_epoch=999 AND bound_node_id IS NULL', 'new name-only registration binds once and its holder can refresh with either shape');
