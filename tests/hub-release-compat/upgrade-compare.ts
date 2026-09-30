const r = (f: string) => JSON.parse(require("fs").readFileSync(f, "utf8"));
const [a, b, c, d, late] = ["/tmp/old_a.json", "/tmp/new_a.json", "/tmp/old_b.json", "/tmp/new_b.json", "/tmp/late.json"].map(r);
let fails = 0;
const O = process.env.OLD_LABEL ?? ".73", N = process.env.NEW_LABEL ?? ".74";
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) fails++; };
const sameIds = (x: any, y: any) => JSON.stringify(x.visible_ids) === JSON.stringify(y.visible_ids);
// Every field the pre-existing member saw on .73 keeps its value on .74; list only fields .74 adds.
function superset(x: any, y: any, label: string) {
  const added = new Set<string>(); let changed: string[] = [];
  for (const [id, cx] of Object.entries<any>(x.cards)) {
    const cy = y.cards[id];
    if (!cx || !cy) { changed.push(`${id}:missing`); continue; }
    for (const k of Object.keys(cx)) if (JSON.stringify(cx[k]) !== JSON.stringify(cy[k])) changed.push(`${id}.${k}`);
    for (const k of Object.keys(cy)) if (!(k in cx)) added.add(k);
  }
  check(changed.length === 0, `${label}: every ${O} field unchanged (${changed.join(",") || "none changed"})`);
  return [...added].sort();
}
check(a.health === 200 && a.visible_ids.length === 3, `${O} seed: member sees ${a.visible_ids.length} of 3 cards`);
check(b.health === 200 && sameIds(a, b), `${N} on the ${O} database: member sees the same ${b.visible_ids.length} cards`);
const added = superset(a, b, `${O} → ${N}`);
console.log(`INFO fields added on ${N} cards: ${added.join(",") || "none"}`);
check(b.grants_status === 200 && b.grants_task_access === "all", `${N}: pre-existing member has task_access=all (admin view: ${b.grants_status} ${b.grants_task_access})`);
const cardsB = Object.values<any>(b.cards);
const done = cardsB.find((x) => x?.column === "done");
const notDone = cardsB.filter((x) => x && x.column !== "done");
check(cardsB.length === 3 && notDone.length === 2, `${N} card columns read back (${cardsB.map((x) => x?.column).join(",")})`);
if (process.env.EXPECT_BACKFILL !== "0") check(!!done && typeof done.completedAt === "string" && done.completedAtApprox === true, `${N} backfilled completedAt on the done card (${done?.completedAt}, approx=${done?.completedAtApprox})`);
else check(!!done && typeof done.completedAt === "string" && JSON.stringify(a.cards) === JSON.stringify(b.cards), `${N} keeps the done card's completedAt exactly as ${O} set it (${done?.completedAt})`);
check(notDone.every((x) => x.completedAt == null), `${N}: cards not done have no completedAt`);
check(c.health === 200 && sameIds(a, c), `rollback: ${O} on the ${N}-migrated database starts and the member sees the same cards`);
superset(a, c, `rollback ${N} → ${O} (vs original ${O} view)`);
check(d.health === 200 && sameIds(b, d), `re-upgrade ${O} → ${N} again: same cards`);
superset(b, d, `re-upgrade (vs first ${N} view)`);
check(late.add_status === 200 && late.task_access === "all" && late.visible === late.of, `member added after the upgrade via the old-app request (no task_access): task_access=${late.task_access}, sees ${late.visible} of ${late.of} cards`);
if (process.env.CHECK_BYTES === "1") {
  const same = a.list_sha_member === b.list_sha_member && a.list_sha_admin === b.list_sha_admin;
  check(same || (a.list_nocaps_member === b.list_nocaps_member && a.list_nocaps_admin === b.list_nocaps_admin && b.caps_added_ok),
    same ? `full list (no new params) byte-identical ${O} vs ${N} on the same DB`
         : `full list (no new params) identical ${O} vs ${N} except capabilities, which only appends [${b.caps_added?.join(",")}] (old list kept as prefix: ${b.caps_added_ok})`);
  check(c.list_sha_member === a.list_sha_member, `rollback ${O}: full list byte-identical to the original ${O} response`);
  check(d.list_sha_member === b.list_sha_member, `re-upgrade ${N}: full list byte-identical to the first ${N} response`);
}
console.log(`upgrade_check_failures=${fails}`);
process.exit(fails ? 1 : 0);
