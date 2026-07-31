import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const path of ["README.md", "README.en.md"]) {
  check(read(path).split("\n").length <= 100, `${path} exceeds 100 lines`);
}
for (const path of ["docs-site/docs/index.md", "docs-site/docs/en/index.md"]) {
  check(read(path).split("\n").length <= 50, `${path} exceeds 50 lines`);
}

const layout = read("docs-site/docs/.vitepress/theme/Layout.vue");
for (const staleLayer of ["FeatureGrid", "HeroBadges", "HeroNotice", "HeroVideo", "InstallCommand"]) {
  check(!layout.includes(staleLayer), `homepage still injects the duplicate ${staleLayer} layer`);
}
for (const removedComponent of [
  "FeatureGrid.vue",
  "HeroBadges.vue",
  "HeroNotice.vue",
  "HeroVideo.vue",
  "InstallCommand.vue",
]) {
  check(!existsSync(`docs-site/docs/.vitepress/theme/components/${removedComponent}`), `stale component remains: ${removedComponent}`);
}

const promotedInstallerClaims = [
  "`setup-anet.sh` 在一台空 Ubuntu/Debian 上一行命令起",
  "`setup-anet.sh` spins up hub + dashboard",
  "一键安装（实验性）",
  "One-shot install (experimental)",
  "[一键安装与起步](/guide/one-shot-install)",
  "[One-shot install](/en/guide/one-shot-install) — first",
  "[一键安装](/guide/one-shot-install) — 最快路径",
  "[One-shot install](/en/guide/one-shot-install) — fastest path",
];
const activeDocs = [
  "docs-site/docs/guide/getting-started.md",
  "docs-site/docs/en/guide/getting-started.md",
  "docs-site/docs/deploy/docker.md",
  "docs-site/docs/en/deploy/docker.md",
  "docs-site/docs/guide/multi-model.md",
  "docs-site/docs/en/guide/multi-model.md",
  "docs-site/docs/guide/account-system.md",
  "docs-site/docs/en/guide/account-system.md",
  "docs-site/docs/deploy/npm.md",
  "docs-site/docs/en/deploy/npm.md",
  "docs-site/docs/community.md",
  "docs-site/docs/en/community.md",
  "docs-site/docs/ecosystem.md",
  "docs-site/docs/en/ecosystem.md",
];

const validateActiveDocs = (documents) => {
  const errors = [];
  for (const [path, text] of documents) {
    for (const claim of promotedInstallerClaims) {
      if (text.includes(claim)) errors.push(`${path}: ${claim}`);
    }
  }
  return errors;
};

const documents = activeDocs.map((path) => [path, read(path)]);
const mutation = documents.map(([path, text]) => [path, text]);
mutation[0] = [mutation[0][0], `${mutation[0][1]}\n一键安装（实验性）\n`];
check(validateActiveDocs(mutation).length === 1, "witnessed-red mutation was not detected exactly once");
check(validateActiveDocs(documents).length === 0, `stale installer claim remains: ${validateActiveDocs(documents).join("; ")}`);

check(read("docs-site/docs/guide/one-shot-install.md").includes("一键安装脚本已退役"), "Chinese retirement page missing");
check(read("docs-site/docs/en/guide/one-shot-install.md").includes("One-shot installer retired"), "English retirement page missing");
check(read("docs-site/docs/public/setup-anet.sh").includes("已退役"), "public compatibility stub is not retired");
check(read("docs/upgrade-v2.md").includes("本文中的旧版本号只描述当时迁移背景"), "historical upgrade note still presents a stale current version");

for (const route of [
  "docs-site/docs/guide/getting-started.md",
  "docs-site/docs/en/guide/getting-started.md",
  "docs-site/docs/deploy/clean-server.md",
  "docs-site/docs/en/deploy/clean-server.md",
  "docs-site/docs/deploy/production.md",
  "docs-site/docs/en/deploy/production.md",
]) {
  check(existsSync(route), `linked route missing: ${route}`);
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS: front doors remain concise");
console.log("PASS: stale setup-anet promotions removed from active bilingual docs");
console.log("PASS: witnessed-red validator catches a reintroduced promotion");
console.log("PASS: retirement and replacement routes exist");

execFileSync("npm", ["run", "build"], {
  cwd: "/workspace/docs-site",
  stdio: "inherit",
});
console.log("PASS: VitePress production build");
