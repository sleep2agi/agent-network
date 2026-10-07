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
