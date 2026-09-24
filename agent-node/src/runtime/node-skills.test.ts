// 节点技能只读查看 —— 根目录选择、列表去重、描述解析、读取安全边界、门铃 ack。
// 跑法:cd agent-node && bun test src/runtime/node-skills.test.ts
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SKILL_FILE_MAX_BYTES,
  isValidSkillName,
  listSkills,
  parseSkillDescription,
  readSkill,
  skillRootsForRuntime,
} from "./node-skills";
import { processRulesFileRequests } from "./rules-file";

async function tmp(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
async function skill(root: string, name: string, body: string): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, "SKILL.md"), body, "utf8");
}
const md = (desc: string, rest = "body\n") => `---\nname: x\ndescription: ${desc}\n---\n${rest}`;

describe("roots follow each runtime's documented locations", () => {
  const ctx = { workDir: "/w", home: "/h", codexHome: "/ch" };
  test("claude: project .claude/skills before user ~/.claude/skills", () => {
    expect(skillRootsForRuntime("claude", ctx).map((r) => [r.dir, r.label, r.scope])).toEqual([
      ["/w/.claude/skills", ".claude/skills", "project"],
      ["/h/.claude/skills", "~/.claude/skills", "user"],
    ]);
  });
  test("codex / codex-app-server: .agents/skills, $CODEX_HOME/skills, .system", () => {
    for (const rt of ["codex", "codex-app-server"]) {
      expect(skillRootsForRuntime(rt, ctx).map((r) => r.dir)).toEqual(["/w/.agents/skills", "/ch/skills", "/ch/skills/.system"]);
    }
    expect(skillRootsForRuntime("codex", { workDir: "/w", home: "/h" })[1]!.dir).toBe("/h/.codex/skills");
  });
  test("grok and opencode include their own dirs plus the compat dirs", () => {
    expect(skillRootsForRuntime("grok", ctx).map((r) => r.label)).toEqual([
      ".grok/skills", ".agents/skills", ".claude/skills", "~/.grok/skills", "~/.agents/skills", "~/.claude/skills",
    ]);
    expect(skillRootsForRuntime("opencode", ctx).map((r) => r.label)).toEqual([
      ".opencode/skill", ".opencode/skills", "~/.config/opencode/skill", "~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills",
    ]);
  });
  test("unknown runtime → no roots (nothing is read)", () => {
    expect(skillRootsForRuntime("mystery", ctx)).toEqual([]);
    expect(skillRootsForRuntime(undefined, ctx)).toEqual([]);
  });
});

describe("frontmatter description", () => {
  test("plain, quoted, folded and literal blocks; no frontmatter → empty", () => {
    expect(parseSkillDescription(md("Plain words here"))).toBe("Plain words here");
    expect(parseSkillDescription(md('"Quoted: with colon"'))).toBe("Quoted: with colon");
    expect(parseSkillDescription("---\ndescription: >\n  folded one\n  folded two\nname: y\n---\n")).toBe("folded one folded two");
    expect(parseSkillDescription("---\ndescription: |\n  line one\n  line two\n---\n")).toBe("line one\nline two");
    expect(parseSkillDescription("# no frontmatter\ndescription: nope\n")).toBe("");
  });
  test("long descriptions are truncated to 300 chars", () => {
    const d = parseSkillDescription(md("x".repeat(1000)));
    expect(d.length).toBe(300);
    expect(d.endsWith("…")).toBe(true);
  });
});

describe("list", () => {
  test("project + user scopes, project wins on a name clash, non-skill entries ignored", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    await skill(path.join(work, ".claude/skills"), "deploy", md("project deploy"));
    await skill(path.join(home, ".claude/skills"), "deploy", md("user deploy — shadowed"));
    await skill(path.join(home, ".claude/skills"), "review", md("user review"));
    await fs.mkdir(path.join(home, ".claude/skills", "no-skill-md"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude/skills", "loose.md"), "not a skill dir", "utf8");
    const list = await listSkills("claude", { workDir: work, home });
    expect(list).toEqual([
      { name: "deploy", scope: "project", path_rel: ".claude/skills/deploy/SKILL.md", description: "project deploy" },
      { name: "review", scope: "user", path_rel: "~/.claude/skills/review/SKILL.md", description: "user review" },
    ]);
    // 外传路径不含本机绝对路径
    for (const s of list) expect(s.path_rel.includes(home) || s.path_rel.includes(work)).toBe(false);
  });

  test("a symlinked skill that points outside its root is not listed", async () => {
    const work = await tmp("skills-w-");
    const outside = await tmp("skills-out-");
    await skill(outside, "evil", md("escaped"));
    await fs.mkdir(path.join(work, ".claude/skills"), { recursive: true });
    await fs.symlink(path.join(outside, "evil"), path.join(work, ".claude/skills", "evil"));
    expect(await listSkills("claude", { workDir: work, home: await tmp("skills-h-") })).toEqual([]);
  });

  test("missing roots are fine", async () => {
    expect(await listSkills("claude", { workDir: await tmp("skills-w-"), home: await tmp("skills-h-") })).toEqual([]);
  });
});

describe("read", () => {
  test("returns the SKILL.md text with its scope and display path", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const body = md("user review", "# Review\nsteps\n");
    await skill(path.join(home, ".claude/skills"), "review", body);
    const r = await readSkill("claude", { workDir: work, home }, "review");
    expect(r).toEqual({ name: "review", scope: "user", path_rel: "~/.claude/skills/review/SKILL.md", description: "user review", content: body });
  });

  test("unknown name → clean error; traversal / separators → invalid name before any fs access", async () => {
    const ctx = { workDir: await tmp("skills-w-"), home: await tmp("skills-h-") };
    await expect(readSkill("claude", ctx, "nope")).rejects.toThrow("skill not found: nope");
    for (const bad of ["..", ".", "../etc", "a/b", "a\\b", "", "x".repeat(65), 42, null]) {
      expect(isValidSkillName(bad)).toBe(false);
      await expect(readSkill("claude", ctx, bad)).rejects.toThrow("invalid skill name");
    }
  });

  test("symlink escape is refused on read", async () => {
    const work = await tmp("skills-w-");
    const outside = await tmp("skills-out-");
    await skill(outside, "evil", md("escaped"));
    await fs.mkdir(path.join(work, ".claude/skills"), { recursive: true });
    await fs.symlink(path.join(outside, "evil"), path.join(work, ".claude/skills", "evil"));
    await expect(readSkill("claude", { workDir: work, home: await tmp("skills-h-") }, "evil")).rejects.toThrow("outside its skills directory");
  });

  test("oversized SKILL.md is refused", async () => {
    const work = await tmp("skills-w-");
    await skill(path.join(work, ".claude/skills"), "big", "x".repeat(SKILL_FILE_MAX_BYTES + 1));
    await expect(readSkill("claude", { workDir: work, home: await tmp("skills-h-") }, "big")).rejects.toThrow("over the");
  });
});

describe("doorbell ops skills_list / skill_read", () => {
  test("list and read ack done with JSON content; unknown skill acks failed", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    await skill(path.join(work, ".claude/skills"), "deploy", md("project deploy"));
    const queue = [
      { request_id: "r1", op: "skills_list" },
      { request_id: "r2", op: "skill_read", content: "deploy" },
      { request_id: "r3", op: "skill_read", content: "missing" },
    ];
    const acks: any[] = [];
    await processRulesFileRequests({
      callCommHub: async (method, params) => {
        if (method === "get_rules_file_request") return { ok: true, request: queue.shift() ?? null };
        acks.push(params);
        return { ok: true };
      },
      runtime: "claude",
      workDir: work,
      home,
      log: () => {},
      warn: () => {},
    });
    expect(acks.map((a) => [a.request_id, a.status])).toEqual([["r1", "done"], ["r2", "done"], ["r3", "failed"]]);
    expect(JSON.parse(acks[0].content).skills.map((s: any) => s.name)).toEqual(["deploy"]);
    expect(JSON.parse(acks[1].content).content).toContain("project deploy");
    expect(acks[2].error).toContain("skill not found: missing");
    expect(acks[2].file_name).toBe("skills");
  });
});
