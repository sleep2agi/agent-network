import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const pages = {
  zhIntro: read("docs-site/docs/guide/introduction.md"),
  enIntro: read("docs-site/docs/en/guide/introduction.md"),
  zhEcosystem: read("docs-site/docs/ecosystem.md"),
  enEcosystem: read("docs-site/docs/en/ecosystem.md"),
  zhCommunity: read("docs-site/docs/community.md"),
  enCommunity: read("docs-site/docs/en/community.md"),
};

for (const [name, text] of Object.entries(pages)) {
  const limit = name.includes("Intro") ? 70 : name.includes("Ecosystem") ? 35 : 30;
  check(text.split("\n").length <= limit, `${name} exceeds ${limit} lines`);
}

const unsupportedClaims = [
  "企业级多 AI Agent",
  "enterprise-grade multi-AI-agent",
  "一行命令启动",
  "one command to start",
  "约 40 个 MCP Tools",
  "~40 MCP Tools",
  "根据任务类型自动分配",
  "automatically assigning the best model",
  "每个任务只需几分钱",
  "Each task costs just a few cents",
  "100 个 AI Agent",
  "100 AI agents",
];
const validateClaims = (documents) => {
  const errors = [];
  for (const [name, text] of Object.entries(documents)) {
    for (const claim of unsupportedClaims) {
      if (text.includes(claim)) errors.push(`${name}: ${claim}`);
    }
  }
  return errors;
};
const mutation = { ...pages, zhIntro: `${pages.zhIntro}\n企业级多 AI Agent\n` };
check(validateClaims(mutation).length === 1, "witnessed-red claim mutation was not detected exactly once");
check(validateClaims(pages).length === 0, `unsupported claim remains: ${validateClaims(pages).join("; ")}`);

for (const marker of [
  "npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node",
  "Node.js ≥ 22.13",
  "127.0.0.1",
  "npm `latest`",
]) {
  check(pages.zhIntro.includes(marker), `Chinese intro missing ${marker}`);
  check(pages.enIntro.includes(marker), `English intro missing ${marker}`);
}

const config = read("docs-site/docs/.vitepress/config.ts");
const zhSidebar = config.slice(config.indexOf("sidebar:"), config.indexOf("    en: {"));
const enSidebar = config.slice(config.indexOf("sidebar:", config.indexOf("    en: {")), config.lastIndexOf("\n  themeConfig:"));
check((zhSidebar.match(/link:/g) ?? []).length <= 30, "Chinese sidebar still has more than 30 links");
check((enSidebar.match(/link:/g) ?? []).length <= 30, "English sidebar still has more than 30 links");

const externalUrls = [
  "https://github.com/sleep2agi/agent-network",
  "https://paperscope.ai",
  "https://ai-insight.org",
  "https://github.com/sleep2agi/agent-network/discussions",
  "https://github.com/sleep2agi/agent-network/issues",
];
for (const url of externalUrls) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "anet-doc-audit" },
    });
    check(response.ok, `${url} returned HTTP ${response.status}`);
  } catch (error) {
    failures.push(`${url} failed: ${error.message}`);
  }
}

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS: six bilingual core pages stay concise");
console.log("PASS: unsupported marketing claims are absent and witnessed-red works");
console.log("PASS: concise intro retains install, version, and loopback facts");
console.log("PASS: sidebars stay below 30 links per language");
console.log("PASS: ecosystem and community destinations are reachable");

execFileSync("npm", ["run", "build"], {
  cwd: "/workspace/docs-site",
  stdio: "inherit",
});
console.log("PASS: VitePress production build");
