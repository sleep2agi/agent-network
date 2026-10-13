import { readFileSync, writeFileSync, existsSync } from "node:fs";
if (!existsSync("/.dockerenv")) throw Error("container only");

const BOUNDARY_FAILS = 12;

async function runMutation(label: string, file: string, from: string, to: string, testName: string) {
  if (process.env.MUTATION_CASE !== label) return;
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw Error(`anchor not unique: ${label}`);
  try {
    writeFileSync(file, original.replace(from, to));
    const process_ = Bun.spawn(
      ["bun", "test", "src/node-caller-identity-http.test.ts", "-t", testName],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, rc] = await Promise.all([
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
      process_.exited,
    ]);
    const log = (out + err).replace(/\x1b\[[0-9;]*m/g, "");
    const boundaryFails = (log.match(/\(fail\) caller identity boundary:/g) || []).length
      || (log.match(/✗ caller identity boundary:/g) || []).length;
    const namedFail = log.includes(`(fail) ${testName}`) || log.includes(`✗ ${testName}`);
    if (!rc || !log.includes("expect(received)")) throw Error(`NOT assertion-red ${label}\n${log}`);
    if (label === "owner") {
      if (boundaryFails !== BOUNDARY_FAILS) throw Error(`expected ${BOUNDARY_FAILS} boundary failures, saw ${boundaryFails}\n${log}`);
    } else if (["sendermcp", "senderrest", "renameprepare"].includes(label)) {
      const expected = label === "renameprepare" ? 2 : 4;
      const count = log.split(`(fail) ${testName}`).length - 1;
      if (count !== expected) throw Error(`expected ${expected} named assertion failures, saw ${count}\n${log}`);
    } else if (!namedFail) {
      throw Error(`NOT assertion-red ${label}\n${log}`);
    }
    console.log(`WITNESSED_RED ${label} rc=${rc}`);
  } finally {
    writeFileSync(file, original);
  }
}

await runMutation(
  "owner",
  "src/create-node.ts",
  'if (!ownsNode && !boundToNode && !legacyOwnerless) return { ok: false, reason: "not_owner" };',
  "",
  "caller identity boundary:",
);
await runMutation(
  "boundmissing",
  "src/create-node.ts",
  'if (tokRow.bound_node_id && !nodeRow) return { ok: false, reason: "bound_node_missing" };',
  `if (tokRow.bound_node_id && !nodeRow) {
    const named = db.get<DaemonRow>(\`SELECT node_id, alias, network_id, owner_user_id FROM nodes WHERE alias = ?1 AND network_id = ?2\`, tokenAlias, tokRow.network_id);
    if (named && tokRow.user_id === named.owner_user_id) return { ok: true, kind: "node", nodeId: named.node_id, alias: named.alias, networkId: named.network_id };
    return { ok: false, reason: "bound_node_missing" };
  }`,
  "bound row missing does not fall back to the name",
);
await runMutation(
  "unbounddup",
  "src/create-node.ts",
  "if (owned.length === 1) return owned[0]; // board679-unbound-dup",
  "if (owned.length === 1) return undefined; // board679-unbound-dup",
  "duplicate alias unbound token keeps the owning node online",
);
await runMutation(
  "plainntok",
  "src/server.ts",
  'else if (resolvedCaller && resolvedCaller.reason !== "not_a_node_token") { // board679-plain-ntok',
  "else if (true) { // board679-plain-ntok",
  "registration network token signs as the username",
);
await runMutation(
  "ownerlessdup",
  "src/create-node.ts",
  "const legacyOwnerless = nodeRow.owner_user_id === null && tokRow.node_identity_epoch === 0;",
  "const legacyOwnerless = false;",
  "duplicate ownerless row keeps an unbound epoch 0 token online",
);
await runMutation(
  "plainntokrest",
  "src/rest-identity.ts",
  '} else if (resolved.reason === "not_a_node_token") { // board679-plain-ntok-rest',
  "} else if (false) { // board679-plain-ntok-rest",
  "unreported registration token signs as api",
);

await runMutation("sendermcp", "src/tools.ts",
  'const fromNodeId = humanSender ? null : callerTokenIsNetwork\n        ? (senderIdentity?.ok && senderIdentity.kind === "node" && senderIdentity.networkId === effectiveNetId ? senderIdentity.nodeId : null)\n        : resolveNodeIdForAlias(from_session, effectiveNetId);',
  'const fromNodeId = humanSender ? null : resolveNodeIdForAlias(from_session, effectiveNetId);',
  "node attribution: mcp");
await runMutation("senderrest", "src/server.ts",
  '? (identity.nodeId ?? null)', '? resolveRestNodeIdForAlias(fromSession, taskNetId)',
  "node attribution: rest");
await runMutation("renameprepare", "src/rename.ts",
  'const newInSessions = db.get<any>(\n    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2 UNION ALL SELECT 1 FROM nodes WHERE network_id = ?1 AND alias = ?2", networkId, newAlias);',
  'const newInSessions = db.get<any>(\n    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2", networkId, newAlias);',
  "rename registry: prepare rejects");
await runMutation("renamecommit", "src/rename.ts",
  'const conflict = db.get<any>(\n    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2 UNION ALL SELECT 1 FROM nodes WHERE network_id = ?1 AND alias = ?2", txn.network_id, txn.new_alias);',
  'const conflict = db.get<any>(\n    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2", txn.network_id, txn.new_alias);',
  "rename registry: commit rejects a node created after prepare");

await runMutation("daemonidentity", "src/node-daemon-bindings.ts",
  'return activeNodeTokenIds(daemon.node_id, daemon.network_id).length ? null : "daemon_offline";',
  'return db.get("SELECT token_id FROM api_tokens WHERE name=?1 AND network_id=?2 AND revoked_at IS NULL", `node:${daemon.alias}`, daemon.network_id) ? null : "daemon_offline";',
  "token lifecycle: adoption rejects a different node's same-name credential");
await runMutation("freezetoken", "src/tools.ts",
  'const childTokenId = activeNodeTokenIds(node.node_id, node.network_id)[0] ?? null;',
  'const childTokenId = db.get<{token_id:string}>("SELECT token_id FROM api_tokens WHERE network_id=?1 AND name=?2 AND revoked_at IS NULL",node.network_id,`node:${node.alias}`)?.token_id ?? null;',
  "token lifecycle: delete frozen revokes only the target credential");
await runMutation("legacyrevoke", "src/node-token-identity.ts",
  'ids = activeNodeTokenIds(nodeId, networkId);',
  'const node=db.get<{alias:string}>("SELECT alias FROM nodes WHERE node_id=?1",nodeId); ids=db.all<{token_id:string}>("SELECT token_id FROM api_tokens WHERE network_id=?1 AND name=?2 AND revoked_at IS NULL",networkId,`node:${node?.alias}`).map(t=>t.token_id);',
  "token lifecycle: delete legacy null revokes only the target credential");
await runMutation("frozenrevoke", "src/node-token-identity.ts",
  '? [frozenTokenId] : activeNodeTokenIds(nodeId, networkId);',
  '? [frozenTokenId] : [frozenTokenId];',
  "token lifecycle: delete wrong frozen revokes only the target credential");
await runMutation("renametokens", "src/rename.ts",
  'for (const tokenId of tokenIds) db.run(\n      "UPDATE api_tokens SET name = ?1 WHERE token_id = ?2 AND network_id = ?3",\n      [`node:${txn.new_alias}`, tokenId, txn.network_id]);',
  'db.run("UPDATE api_tokens SET name=?1 WHERE network_id=?2 AND name=?3",[`node:${txn.new_alias}`,txn.network_id,`node:${txn.old_alias}`]);',
  "token lifecycle: rename updates verified labels and preserves unrelated credentials");
await runMutation("renameambiguous", "src/rename.ts",
  'if (nodes.length > 1) return { ok: false, error: "node_alias_ambiguous" };',
  '',
  "token lifecycle: rename refuses ambiguous node rows before and after prepare");
