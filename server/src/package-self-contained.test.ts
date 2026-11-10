// commhub-server ships only `src/`, `bin/` and build-info.json (package.json "files").
// A non-test module that imports a path outside this package works in the repo but
// makes the published Hub crash at startup ("Cannot find module ../../contracts/…",
// seen in the e2e npm-pack suite). Pin it: every relative import from shipped code
// must resolve inside server/.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const IMPORT_RE = /(?:from|import\(|require\()\s*["'](\.{1,2}\/[^"']+)["']/g;

function shipped(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "fixtures") out.push(...shipped(p)); }
    else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\.(ts|js)$/.test(name)) out.push(p);
  }
  return out;
}

test("shipped server code never imports outside the commhub-server package", () => {
  const escapes: string[] = [];
  for (const file of [...shipped(join(root, "src")), ...shipped(join(root, "bin"))]) {
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const target = resolve(dirname(file), m[1]);
      if (!target.startsWith(root + sep)) escapes.push(`${file.slice(root.length + 1)} → ${m[1]}`);
    }
  }
  expect(escapes).toEqual([]);
});
