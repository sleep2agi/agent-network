import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (!existsSync('/.dockerenv')) throw Error('container only');
async function mutate(label: string, from: string, to: string, testName: string) {
  if (process.env.MUTATION_CASE !== label) return;
  const path = 'src/agent-teams.ts', source = readFileSync(path, 'utf8');
  if (source.split(from).length !== 2) throw Error(`mutation anchor not unique: ${label}`);
  try {
    writeFileSync(path, source.replace(from, to));
    const p = Bun.spawn(['bun', 'test', 'src/agent-team-whoami-http.test.ts', '-t', testName], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (rc === 0 || !(out + err).includes(`(fail) ${testName}`) || !(out + err).includes('expect(received)')) throw Error(`not assertion-red ${label}\n${out}${err}`);
    console.log(`WITNESSED_RED ${label} rc=${rc} assertion=${testName}`);
  } finally { writeFileSync(path, source); }
}
await mutate('identity', 'const self = teams.find(t => t.members.some(n => n.node_id === nodeId));', 'const self = teams[0];', 'unassigned node does not inherit its owner or another node team');
await mutate('network', '"SELECT node_id, alias, display_name FROM nodes WHERE network_id = ?1", networkId', '"SELECT node_id, alias, display_name FROM nodes WHERE CAST(?1 AS TEXT) IS NOT NULL", networkId', 'same-id foreign team and foreign node cannot cross network; supplied identity is ignored');
await mutate('bound', 'if (!nodeId) return { ok: false, error: "node_identity_unbound" };', '', 'unassigned node does not inherit its owner or another node team');
await mutate('cap', 'self.members.slice(0, 50)', 'self.members', 'large teams are bounded to 50 and explicitly truncated');
