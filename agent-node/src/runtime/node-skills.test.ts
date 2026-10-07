// 节点技能只读查看 —— 根目录选择、列表去重、描述解析、读取安全边界、门铃 ack。
// 跑法:cd agent-node && bun test src/runtime/node-skills.test.ts
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SKILL_FILE_MAX_BYTES,
  installTeamSkills,
  isOurTeamEntry,
  isValidSkillName,
  listSkills,
  parseSkillDescription,
  readSkill,
  skillRootsForRuntime,
  skillView,
  teamSkillDest,
  teamSkillsDir,
  TEAM_COPY_MARKER,
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
    const listed = JSON.parse(acks[0].content);
    expect(listed.skills.map((s: any) => s.name)).toEqual(["deploy"]);
    expect(listed.roots).toEqual([".claude/skills", "~/.claude/skills"]);
    expect(listed.warnings).toEqual([]);
    expect(JSON.parse(acks[1].content).content).toContain("project deploy");
    expect(acks[2].error).toContain("skill not found: missing");
    expect(acks[2].file_name).toBe("skills");
  });
});

describe("team skills", () => {
  function say() {
    const logs: string[] = [];
    const warns: string[] = [];
    return { logs, warns, log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) };
  }
  function noHome(lines: string[], home: string) {
    for (const line of lines) expect(line.includes(home)).toBe(false);
  }

  test("claude links into ~/.claude/skills, bytes match, log says machine-wide", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    const team = teamSkillsDir(ctx);
    const body = md("echo", "team-echo-ok\n");
    await skill(team, "team-echo", body);
    const io = say();
    await installTeamSkills("claude", ctx, io);
    const dest = path.join(home, ".claude", "skills", "team-echo");
    expect(await fs.readlink(dest)).toBe(path.join(team, "team-echo"));
    expect(await fs.readFile(path.join(dest, "SKILL.md"), "utf8")).toBe(body);
    expect(io.logs).toEqual(["[skills] 团队技能 team-echo 已链到 ~/.claude/skills（全机生效，本机所有 claude 节点）"]);
    noHome([...io.logs, ...io.warns], home);
    const listed = await listSkills("claude", ctx);
    expect(listed).toEqual([{ name: "team-echo", scope: "user", path_rel: "~/.claude/skills/team-echo/SKILL.md", description: "echo", origin: "team" }]);
    const read = await readSkill("claude", ctx, "team-echo");
    expect(read.content).toBe(body);
    expect(read.origin).toBe("team");
    const view = await skillView("claude", ctx);
    expect(view.roots).toEqual([".claude/skills", "~/.claude/skills"]);
    expect(view.warnings).toEqual([]);
    const again = say();
    await installTeamSkills("claude", ctx, again);
    expect(again.logs).toEqual([]);
    expect(again.warns).toEqual([]);
  });

  test("a pre-existing dest that is not ours is left in place", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    await skill(teamSkillsDir(ctx), "team-echo", md("team", "TEAM\n"));
    const dest = path.join(home, ".claude", "skills", "team-echo");
    await skill(path.join(home, ".claude/skills"), "team-echo", "LOCAL\n");
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dest, "SKILL.md"), "utf8")).toBe("LOCAL\n");
    expect(io.logs).toEqual([]);
    expect(io.warns).toEqual(["[skills] 团队技能 team-echo 未覆盖 ~/.claude/skills/team-echo：目标已存在，且不是指向团队目录的链接"]);
    noHome(io.warns, home);
    expect((await skillView("claude", ctx)).warnings).toEqual(["团队技能 team-echo 未覆盖 ~/.claude/skills/team-echo：目标已存在，且不是指向团队目录的链接"]);
  });

  test("ownership is the link target, not the directory name", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const outside = await tmp("skills-out-");
    const ctx = { workDir: work, home };
    const team = teamSkillsDir(ctx);
    await skill(team, "team-echo", md("echo"));
    await skill(outside, "foreign", md("foreign"));
    const user = path.join(home, ".claude", "skills");
    await fs.mkdir(user, { recursive: true });
    await fs.symlink(path.join(outside, "foreign"), path.join(user, "team-echo"));
    await fs.symlink(path.join(team, "team-echo"), path.join(user, "custom-name"));
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect(await fs.readlink(path.join(user, "team-echo"))).toBe(path.join(outside, "foreign"));
    expect(await fs.readlink(path.join(user, "custom-name"))).toBe(path.join(team, "team-echo"));
    expect(io.warns.some((l) => l.includes("未覆盖") && l.includes("team-echo"))).toBe(true);
    await fs.rm(path.join(team, "team-echo"), { recursive: true });
    const io2 = say();
    await installTeamSkills("claude", ctx, io2);
    expect(await fs.readlink(path.join(user, "team-echo"))).toBe(path.join(outside, "foreign"));
    await expect(fs.lstat(path.join(user, "custom-name"))).rejects.toThrow();
    expect(io2.logs).toEqual(["[skills] 已移除失效的团队链接 ~/.claude/skills/custom-name"]);
    noHome([...io.logs, ...io.warns, ...io2.logs, ...io2.warns], home);
  });

  test("a marked copy is refreshed by the marker, and a different name is removed only after its source is gone", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    const team = teamSkillsDir(ctx);
    const body = md("echo", "NEW\n");
    await skill(team, "team-echo", body);
    const user = path.join(home, ".claude", "skills");
    const copied = path.join(user, "team-echo");
    const alias = path.join(user, "custom-copy");
    await fs.mkdir(copied, { recursive: true });
    await fs.writeFile(path.join(copied, "SKILL.md"), "OLD\n");
    await fs.writeFile(path.join(copied, TEAM_COPY_MARKER), `anet-team-skill\nsource=${path.join(team, "team-echo")}\n`);
    await fs.mkdir(alias, { recursive: true });
    await fs.writeFile(path.join(alias, "SKILL.md"), "OLD\n");
    await fs.writeFile(path.join(alias, TEAM_COPY_MARKER), `anet-team-skill\nsource=${path.join(team, "team-echo")}\n`);
    await skill(user, "keep-local", "KEEP\n");
    expect(await isOurTeamEntry(copied, team)).toBe(true);
    expect(await isOurTeamEntry(path.join(user, "keep-local"), team)).toBe(false);
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect((await fs.lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(copied, "SKILL.md"), "utf8")).toBe(body);
    expect(await fs.readFile(path.join(alias, "SKILL.md"), "utf8")).toBe("OLD\n");
    expect(await fs.readFile(path.join(user, "keep-local", "SKILL.md"), "utf8")).toBe("KEEP\n");
    await fs.rm(path.join(team, "team-echo"), { recursive: true });
    const io2 = say();
    await installTeamSkills("claude", ctx, io2);
    await expect(fs.lstat(copied)).rejects.toThrow();
    await expect(fs.lstat(alias)).rejects.toThrow();
    expect(await fs.readFile(path.join(user, "keep-local", "SKILL.md"), "utf8")).toBe("KEEP\n");
    expect(io2.logs.slice().sort()).toEqual([
      "[skills] 已移除失效的团队链接 ~/.claude/skills/custom-copy",
      "[skills] 已移除失效的团队链接 ~/.claude/skills/team-echo",
    ]);
  });

  test("two codex homes each get their own link; shared ~/.codex is not used", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const a = path.join(home, "codex-a");
    const b = path.join(home, "codex-b");
    const ctxA = { workDir: work, home, codexHome: a };
    await skill(teamSkillsDir(ctxA), "team-echo", md("echo"));
    const ioA = say();
    const ioB = say();
    await installTeamSkills("codex", ctxA, ioA);
    await installTeamSkills("codex-app-server", { workDir: work, home, codexHome: b }, ioB);
    expect(await fs.readlink(path.join(a, "skills", "team-echo"))).toBe(path.join(teamSkillsDir(ctxA), "team-echo"));
    expect(await fs.readlink(path.join(b, "skills", "team-echo"))).toBe(path.join(teamSkillsDir(ctxA), "team-echo"));
    await expect(fs.lstat(path.join(home, ".codex", "skills", "team-echo"))).rejects.toThrow();
    for (const line of [...ioA.logs, ...ioB.logs]) {
      expect(line).toContain("$CODEX_HOME/skills（仅本节点）");
      expect(line.includes("全机生效")).toBe(false);
      expect(line.includes(home)).toBe(false);
    }
    const shared = say();
    await installTeamSkills("codex", { workDir: work, home, codexHome: path.join(home, ".codex") }, shared);
    expect(shared.logs[0]).toContain("~/.codex/skills（全机生效，本机所有 codex 节点）");
  });

  test("a same-named project skill still gets a user link and stays first in the list", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    await skill(teamSkillsDir(ctx), "team-echo", md("team", "TEAM\n"));
    await skill(path.join(work, ".claude/skills"), "team-echo", md("proj", "PROJ\n"));
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect(await fs.readFile(path.join(home, ".claude", "skills", "team-echo", "SKILL.md"), "utf8")).toContain("TEAM");
    const hit = (await listSkills("claude", ctx)).find((s) => s.name === "team-echo");
    expect(hit).toMatchObject({ scope: "project", path_rel: ".claude/skills/team-echo/SKILL.md" });
    expect(hit && "origin" in hit).toBe(false);
    expect(io.warns).toEqual(["[skills] 团队技能 team-echo 被 .claude/skills/team-echo 挡住"]);
    expect((await skillView("claude", ctx)).warnings).toEqual(["团队技能 team-echo 被 .claude/skills/team-echo 挡住"]);
  });

  test("a same-named .system skill does not warn", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const codexHome = path.join(home, "codex-home");
    const ctx = { workDir: work, home, codexHome };
    await skill(teamSkillsDir(ctx), "builtin", md("team"));
    await skill(path.join(codexHome, "skills", ".system"), "builtin", md("system"));
    const io = say();
    await installTeamSkills("codex", ctx, io);
    expect(io.warns).toEqual([]);
    expect(await fs.readlink(path.join(codexHome, "skills", "builtin"))).toContain(`${path.sep}.anet${path.sep}skills${path.sep}builtin`);
    const listed = await listSkills("codex", ctx);
    expect(listed.find((s) => s.name === "builtin")).toMatchObject({ scope: "user", origin: "team" });
  });

  test("missing team dir is a no-op, and an empty dir still sweeps only our links", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect(io.logs).toEqual([]);
    expect(io.warns).toEqual([]);
    await expect(fs.lstat(path.join(home, ".claude"))).rejects.toThrow();
    const outside = await tmp("skills-out-");
    const user = path.join(home, ".claude", "skills");
    await fs.mkdir(user, { recursive: true });
    await fs.symlink(outside, path.join(user, "keep-mine"));
    await installTeamSkills("claude", ctx, io);
    expect(await fs.readlink(path.join(user, "keep-mine"))).toBe(outside);
    expect(io.logs).toEqual([]);
  });

  test("grok and opencode link only their one user dir", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    await skill(teamSkillsDir(ctx), "team-echo", md("echo"));
    expect(teamSkillDest("grok", ctx)).toMatchObject({ label: "~/.grok/skills", machineWide: true });
    expect(teamSkillDest("opencode", ctx)).toMatchObject({ label: "~/.config/opencode/skills", machineWide: true });
    expect(teamSkillDest("nope", ctx)).toBeNull();
    const grok = say();
    await installTeamSkills("grok", ctx, grok);
    expect(grok.logs[0]).toContain("~/.grok/skills（全机生效，本机所有 grok 节点）");
    expect(await fs.readlink(path.join(home, ".grok", "skills", "team-echo"))).toContain("team-echo");
    await expect(fs.lstat(path.join(home, ".agents", "skills", "team-echo"))).rejects.toThrow();
    await expect(fs.lstat(path.join(home, ".claude", "skills", "team-echo"))).rejects.toThrow();
    const open = say();
    await installTeamSkills("opencode", ctx, open);
    expect(open.logs[0]).toContain("~/.config/opencode/skills（全机生效，本机所有 opencode 节点）");
    expect(await fs.readlink(path.join(home, ".config", "opencode", "skills", "team-echo"))).toContain("team-echo");
    await expect(fs.lstat(path.join(home, ".config", "opencode", "skill", "team-echo"))).rejects.toThrow();
  });

  test("a team SKILL.md that points outside ~/.anet/skills is not installed or readable", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const ctx = { workDir: work, home };
    const evil = path.join(teamSkillsDir(ctx), "evil");
    await fs.mkdir(evil, { recursive: true });
    await fs.symlink("/etc/hostname", path.join(evil, "SKILL.md"));
    const io = say();
    await installTeamSkills("claude", ctx, io);
    expect(io.logs).toEqual([]);
    await expect(fs.lstat(path.join(home, ".claude", "skills", "evil"))).rejects.toThrow();
    await fs.mkdir(path.join(home, ".claude", "skills"), { recursive: true });
    await fs.symlink(evil, path.join(home, ".claude", "skills", "evil"));
    await expect(readSkill("claude", ctx, "evil")).rejects.toThrow("outside its skills directory");
    expect((await listSkills("claude", ctx)).map((s) => s.name)).not.toContain("evil");
  });

  test("~/.anet itself a symlink: second start recognises its own links and a deleted skill's dangling link is cleaned", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const disk = await tmp("skills-disk-");
    await fs.mkdir(path.join(disk, "anet"), { recursive: true });
    await fs.symlink(path.join(disk, "anet"), path.join(home, ".anet"));
    const ctx = { workDir: work, home };
    const team = teamSkillsDir(ctx);
    await skill(team, "team-a", md("a"));
    await skill(team, "team-b", md("b"));
    const user = path.join(home, ".claude", "skills");
    const first = say();
    await installTeamSkills("claude", ctx, first);
    expect(await fs.readlink(path.join(user, "team-a"))).toBe(path.join(disk, "anet", "skills", "team-a"));
    expect(first.warns).toEqual([]);
    expect(await isOurTeamEntry(path.join(user, "team-a"), team)).toBe(true);
    const second = say();
    await installTeamSkills("claude", ctx, second);
    expect(second.logs).toEqual([]);
    expect(second.warns).toEqual([]);
    expect((await skillView("claude", ctx)).warnings).toEqual([]);
    await fs.rm(path.join(team, "team-b"), { recursive: true });
    const third = say();
    await installTeamSkills("claude", ctx, third);
    await expect(fs.lstat(path.join(user, "team-b"))).rejects.toThrow();
    expect(third.logs).toEqual(["[skills] 已移除失效的团队链接 ~/.claude/skills/team-b"]);
    expect(third.warns).toEqual([]);
    expect(await fs.readlink(path.join(user, "team-a"))).toBe(path.join(disk, "anet", "skills", "team-a"));
    // 旧版本按字面路径建的链接（经过 ~/.anet 软链接）同样认作我们的。
    await fs.unlink(path.join(user, "team-a"));
    await fs.symlink(path.join(team, "team-a"), path.join(user, "team-a"));
    const fourth = say();
    await installTeamSkills("claude", ctx, fourth);
    expect(fourth.warns).toEqual([]);
    expect(fourth.logs).toEqual([]);
  });

  test("a .anet-team-copy marker counts only when its source resolves inside the team dir", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    const outside = await tmp("skills-out-");
    const ctx = { workDir: work, home };
    const team = teamSkillsDir(ctx);
    await skill(team, "team-echo", md("echo"));
    await skill(outside, "elsewhere", md("elsewhere"));
    // 团队目录里一个指向外面的软链接：字面路径在团队目录下，真实路径不在。
    await fs.symlink(path.join(outside, "elsewhere"), path.join(team, "sneaky"));
    const user = path.join(home, ".claude", "skills");
    const marked = async (name: string, source: string) => {
      await fs.mkdir(path.join(user, name), { recursive: true });
      await fs.writeFile(path.join(user, name, "SKILL.md"), "USER EDIT\n");
      await fs.writeFile(path.join(user, name, TEAM_COPY_MARKER), `anet-team-skill\nsource=${source}\n`);
    };
    await marked("team-echo", path.join(outside, "elsewhere"));
    await marked("my-fork", path.join(outside, "elsewhere"));
    await marked("via-link", path.join(team, "sneaky"));
    await marked("dotdot", `${team}/../../etc`);
    await marked("gone", path.join(team, "deleted-skill"));
    for (const name of ["team-echo", "my-fork", "via-link", "dotdot"]) {
      expect(await isOurTeamEntry(path.join(user, name), team)).toBe(false);
    }
    expect(await isOurTeamEntry(path.join(user, "gone"), team)).toBe(true);
    const io = say();
    await installTeamSkills("claude", ctx, io);
    for (const name of ["team-echo", "my-fork", "via-link", "dotdot"]) {
      expect((await fs.lstat(path.join(user, name))).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(user, name, "SKILL.md"), "utf8")).toBe("USER EDIT\n");
    }
    await expect(fs.lstat(path.join(user, "gone"))).rejects.toThrow();
    expect(io.warns).toEqual(["[skills] 团队技能 team-echo 未覆盖 ~/.claude/skills/team-echo：目标已存在，且不是指向团队目录的链接"]);
    expect(io.logs).toEqual(["[skills] 已移除失效的团队链接 ~/.claude/skills/gone"]);
  });

  test("a normal user skill omits origin", async () => {
    const work = await tmp("skills-w-");
    const home = await tmp("skills-h-");
    await skill(path.join(home, ".claude/skills"), "notes", md("user notes"));
    const hit = (await listSkills("claude", { workDir: work, home })).find((s) => s.name === "notes");
    expect(hit && "origin" in hit).toBe(false);
  });
});
