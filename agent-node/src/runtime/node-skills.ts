// 节点技能(skills)只读查看 —— 桌面端「节点信息 → 技能」。
//
// 与 rules-file.ts 同一条门铃链路(op = skills_list | skill_read),同样**没有路径参数**:
// hub 只能传一个技能名;根目录由节点按自己的 RUNTIME 决定,且只能读根目录下
// `<name>/SKILL.md` 这一种文件。
//
// 各运行时实际加载技能的位置(以各自二进制内置的文档为准,2026-09-24 核对):
//   claude   —— 「Create skills by adding .md files to .claude/skills/ in your project or
//               ~/.claude/skills/ for skills that work in any project」(Claude Code 2.1.281)
//   codex    —— 用户级 $CODEX_HOME/skills(含 .system/ 内置技能),仓库级 .agents/skills
//               (codex 0.155.1:「Install Codex skills into $CODEX_HOME/skills」、repo skills root)
//   grok     —— ./.grok/skills、<repo>/.grok/skills、~/.grok/skills,另在每一层扫 .agents/skills,
//               并兼容 ./.claude/skills、~/.claude/skills(grok 1.0.5 内置文档表)
//   opencode —— .opencode/skill(s)/<name>/SKILL.md(项目)、~/.config/opencode/skill(s)(全局)、
//               外部自动加载 ~/.claude/skills、~/.agents/skills(opencode 内置文档表)
//
// 🔴 路径安全:技能名只允许 [A-Za-z0-9._-],不能是 . / ..;读取前对 SKILL.md 取 realpath,
//    必须仍在该根目录的 realpath 之内(挡住软链接逃逸)。唯一例外是真实路径落在
//    ~/.anet/skills 里的团队技能。必须是普通文件、不超过上限。
//    返回给 hub 的路径一律是相对显示形式(`.claude/skills/x/SKILL.md`、`~/.claude/skills/...`),
//    不含本机绝对路径。

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_FILE_MAX_BYTES = 256 * 1024;
export const SKILLS_LIST_MAX = 300;
export const SKILL_DESCRIPTION_MAX = 300;
const SKILL_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type SkillScope = "project" | "user" | "system";

export interface SkillRoot {
  /** 绝对目录(只在节点本机使用,不外传)。 */
  dir: string;
  /** 外传的显示前缀,例如 `.claude/skills`、`~/.claude/skills`、`$CODEX_HOME/skills`。 */
  label: string;
  scope: SkillScope;
}

export interface SkillContext {
  workDir: string;
  home?: string;
  codexHome?: string;
}

export interface SkillSummary {
  name: string;
  scope: SkillScope;
  path_rel: string;
  description: string;
  /** 只有团队技能才带。不写进 scope：旧客户端会把不认识的 scope 当成「项目」。 */
  origin?: "team";
}

export function isValidSkillName(name: unknown): name is string {
  return typeof name === "string" && SKILL_NAME_RE.test(name) && name !== "." && name !== "..";
}

/** 按优先级(高 → 低)列出某运行时会加载技能的根目录。同名技能以先出现的为准。 */
export function skillRootsForRuntime(runtime: string | null | undefined, ctx: SkillContext): SkillRoot[] {
  const work = path.resolve(ctx.workDir);
  const home = ctx.home || os.homedir();
  const p = (rel: string, scope: SkillScope): SkillRoot => ({ dir: path.join(work, rel), label: rel, scope });
  const u = (rel: string, scope: SkillScope = "user"): SkillRoot => ({ dir: path.join(home, rel), label: `~/${rel}`, scope });
  switch (runtime) {
    case "claude":
      return [p(".claude/skills", "project"), u(".claude/skills")];
    case "codex":
    case "codex-app-server": {
      const codexHome = ctx.codexHome && ctx.codexHome.trim() ? ctx.codexHome.trim() : path.join(home, ".codex");
      return [
        p(".agents/skills", "project"),
        { dir: path.join(codexHome, "skills"), label: "$CODEX_HOME/skills", scope: "user" },
        { dir: path.join(codexHome, "skills", ".system"), label: "$CODEX_HOME/skills/.system", scope: "system" },
      ];
    }
    case "grok":
      return [
        p(".grok/skills", "project"),
        p(".agents/skills", "project"),
        p(".claude/skills", "project"),
        u(".grok/skills"),
        u(".agents/skills"),
        u(".claude/skills"),
      ];
    case "opencode":
      return [
        p(".opencode/skill", "project"),
        p(".opencode/skills", "project"),
        u(".config/opencode/skill"),
        u(".config/opencode/skills"),
        u(".claude/skills"),
        u(".agents/skills"),
      ];
    default:
      return [];
  }
}

/** 从 SKILL.md 开头的 YAML frontmatter 取 description(单行 / 引号 / `|` `>` 块)。 */
export function parseSkillDescription(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return "";
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const m = /^description\s*:\s*(.*)$/.exec(fm[i]!);
    if (!m) continue;
    let v = m[1]!.trim();
    if (v === "|" || v === ">" || v === "|-" || v === ">-" || v === "") {
      const block: string[] = [];
      for (let j = i + 1; j < fm.length; j++) {
        const line = fm[j]!;
        if (/^\s+\S/.test(line)) block.push(line.trim());
        else if (line.trim() === "") block.push("");
        else break;
      }
      v = block.join(v.startsWith("|") ? "\n" : " ").trim();
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.length > SKILL_DESCRIPTION_MAX ? `${v.slice(0, SKILL_DESCRIPTION_MAX - 1)}…` : v;
  }
  return "";
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export const TEAM_COPY_MARKER = ".anet-team-copy";
const TEAM_MARKER_TOKEN = "anet-team-skill";

export function teamSkillsDir(ctx: SkillContext): string {
  return path.resolve(ctx.home || os.homedir(), ".anet", "skills");
}

function pathIsUnder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 每个运行时只链进这一个用户级目录。codex 用本节点的 CODEX_HOME，没有专属目录才用 ~/.codex。 */
export function teamSkillDest(runtime: string | null | undefined, ctx: SkillContext): { dir: string; label: string; machineWide: boolean } | null {
  const home = ctx.home || os.homedir();
  switch (runtime) {
    case "claude":
      return { dir: path.join(home, ".claude", "skills"), label: "~/.claude/skills", machineWide: true };
    case "grok":
      return { dir: path.join(home, ".grok", "skills"), label: "~/.grok/skills", machineWide: true };
    case "opencode":
      return { dir: path.join(home, ".config", "opencode", "skills"), label: "~/.config/opencode/skills", machineWide: true };
    case "codex":
    case "codex-app-server": {
      const dedicated = ctx.codexHome?.trim();
      const shared = path.join(home, ".codex", "skills");
      if (!dedicated) return { dir: shared, label: "~/.codex/skills", machineWide: true };
      const dir = path.join(dedicated, "skills");
      const machineWide = path.resolve(dir) === path.resolve(shared);
      return { dir, label: machineWide ? "~/.codex/skills" : "$CODEX_HOME/skills", machineWide };
    }
    default:
      return null;
  }
}

function runtimeFamily(runtime: string | null | undefined): string {
  if (runtime === "codex" || runtime === "codex-app-server") return "codex";
  if (runtime === "claude" || runtime === "grok" || runtime === "opencode") return runtime;
  return "该运行时";
}

async function hasTeamCopyMarker(dir: string): Promise<boolean> {
  try {
    const text = await fs.readFile(path.join(dir, TEAM_COPY_MARKER), "utf8");
    return text.startsWith(`${TEAM_MARKER_TOKEN}\n`);
  } catch {
    return false;
  }
}

/** 团队目录的两种写法：字面路径和真实路径。~/.anet 本身可能是指向数据盘的软链接，
 *  而我们建的链接指向的是真实路径，所以两种都要认。 */
async function teamDirForms(teamDir: string): Promise<string[]> {
  const forms = [path.resolve(teamDir)];
  const real = await realpathOrNull(teamDir);
  if (real && real !== forms[0]) forms.push(real);
  return forms;
}

/** p 是否落在团队目录下。存在就按 realpath 判（必须在团队目录的真实路径里）；
 *  不存在（源已被删的悬空链接）才按字面路径对两种写法判。 */
async function resolvesUnderTeam(p: string, teamDir: string): Promise<string | null> {
  const resolved = path.resolve(p);
  const real = await realpathOrNull(resolved);
  if (real) {
    const teamReal = await realpathOrNull(teamDir);
    return teamReal && pathIsUnder(real, teamReal) ? real : null;
  }
  for (const form of await teamDirForms(teamDir)) if (pathIsUnder(resolved, form)) return resolved;
  return null;
}

async function markerSource(dir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(dir, TEAM_COPY_MARKER), "utf8");
    if (!text.startsWith(`${TEAM_MARKER_TOKEN}\n`)) return null;
    const line = text.split(/\r?\n/).find((l) => l.startsWith("source="));
    const src = line?.slice("source=".length).trim();
    return src ? src : null;
  } catch {
    return null;
  }
}

/** 我们建的项指向的团队源（链接目标或复制标记里的 source），必须落在团队目录里；不是我们的返回 null。 */
async function ourEntrySource(dest: string, teamDir: string): Promise<string | null> {
  if (await hasTeamCopyMarker(dest)) {
    const src = await markerSource(dest);
    return src ? resolvesUnderTeam(src, teamDir) : null;
  }
  let link: string;
  try {
    link = await fs.readlink(dest);
  } catch {
    return null;
  }
  return resolvesUnderTeam(path.resolve(path.dirname(dest), link), teamDir);
}

/** 是不是我们建的：链接目标在团队目录下，或者目录里有复制标记。不看名字。 */
export async function isOurTeamEntry(dest: string, teamDir: string): Promise<boolean> {
  if (await hasTeamCopyMarker(dest)) return true;
  return (await ourEntrySource(dest, teamDir)) !== null;
}

async function skillOrigin(skillDir: string, fileReal: string, teamDir: string): Promise<"team" | undefined> {
  if (await hasTeamCopyMarker(skillDir)) return "team";
  const teamReal = await realpathOrNull(teamDir);
  if (teamReal && isInside(fileReal, teamReal)) return "team";
  return undefined;
}

/** 解析某根目录下某技能的 SKILL.md;不存在返回 null;越界 / 非普通文件抛错。
 *  唯一允许落在根目录外面的，是真实路径仍在 ~/.anet/skills 里的团队技能。 */
async function resolveSkillFile(root: SkillRoot, name: string, teamDir: string): Promise<{ file: string; size: number } | null> {
  const rootReal = await realpathOrNull(root.dir);
  if (!rootReal) return null;
  const candidate = path.join(root.dir, name, "SKILL.md");
  const real = await realpathOrNull(candidate);
  if (!real) return null;
  if (!isInside(real, rootReal)) {
    const teamReal = await realpathOrNull(teamDir);
    if (!teamReal || !isInside(real, teamReal)) throw new Error(`skill ${name} resolves outside its skills directory`);
  }
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`skill ${name}: SKILL.md is not a regular file`);
  return { file: real, size: st.size };
}

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function listSkills(runtime: string | null | undefined, ctx: SkillContext): Promise<SkillSummary[]> {
  const seen = new Set<string>();
  const out: SkillSummary[] = [];
  const teamDir = teamSkillsDir(ctx);
  for (const root of skillRootsForRuntime(runtime, ctx)) {
    let entries: string[];
    try {
      entries = (await fs.readdir(root.dir)).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= SKILLS_LIST_MAX) return out;
      if (!isValidSkillName(name) || name.startsWith(".") || seen.has(name)) continue;
      let resolved: { file: string; size: number } | null = null;
      try {
        resolved = await resolveSkillFile(root, name, teamDir);
      } catch {
        continue;
      }
      if (!resolved) continue;
      seen.add(name);
      let description = "";
      try {
        description = parseSkillDescription(await readHead(resolved.file, 64 * 1024));
      } catch {
        description = "";
      }
      const origin = await skillOrigin(path.join(root.dir, name), resolved.file, teamDir);
      out.push({ name, scope: root.scope, path_rel: `${root.label}/${name}/SKILL.md`, description, ...(origin ? { origin } : {}) });
    }
  }
  return out;
}

export interface SkillReadResult extends SkillSummary {
  content: string;
}

export async function readSkill(runtime: string | null | undefined, ctx: SkillContext, name: unknown): Promise<SkillReadResult> {
  if (!isValidSkillName(name)) throw new Error("invalid skill name");
  const teamDir = teamSkillsDir(ctx);
  for (const root of skillRootsForRuntime(runtime, ctx)) {
    const resolved = await resolveSkillFile(root, name, teamDir);
    if (!resolved) continue;
    if (resolved.size > SKILL_FILE_MAX_BYTES) {
      throw new Error(`skill ${name}: SKILL.md is ${resolved.size} bytes, over the ${SKILL_FILE_MAX_BYTES} byte limit`);
    }
    const content = await fs.readFile(resolved.file, "utf8");
    const origin = await skillOrigin(path.join(root.dir, name), resolved.file, teamDir);
    return { name, scope: root.scope, path_rel: `${root.label}/${name}/SKILL.md`, description: parseSkillDescription(content), content, ...(origin ? { origin } : {}) };
  }
  throw new Error(`skill not found: ${name}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function projectHasSkill(runtime: string | null | undefined, ctx: SkillContext, name: string): Promise<string | null> {
  for (const root of skillRootsForRuntime(runtime, ctx)) {
    if (root.scope !== "project") continue;
    const file = path.join(root.dir, name, "SKILL.md");
    if (await pathExists(file)) return root.label;
  }
  return null;
}

async function teamSkillSources(teamDir: string): Promise<{ name: string; src: string }[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(teamDir)).sort();
  } catch {
    return [];
  }
  const teamReal = await realpathOrNull(teamDir);
  if (!teamReal) return [];
  const out: { name: string; src: string }[] = [];
  for (const name of entries) {
    if (!isValidSkillName(name) || name.startsWith(".")) continue;
    const srcReal = await realpathOrNull(path.join(teamDir, name));
    if (!srcReal || !pathIsUnder(srcReal, teamReal)) continue;
    const fileReal = await realpathOrNull(path.join(srcReal, "SKILL.md"));
    if (!fileReal || !isInside(fileReal, teamReal)) continue;
    const st = await fs.stat(fileReal).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ name, src: srcReal });
  }
  return out;
}

async function placeTeamLink(src: string, dest: string): Promise<"linked" | "copied"> {
  try {
    await fs.symlink(src, dest);
    return "linked";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "ENOTSUP" && code !== "EACCES")) throw err;
    try {
      await fs.symlink(src, dest, "junction");
      return "linked";
    } catch {
      await fs.cp(src, dest, { recursive: true });
      await fs.writeFile(path.join(dest, TEAM_COPY_MARKER), `${TEAM_MARKER_TOKEN}\nsource=${src}\n`, "utf8");
      return "copied";
    }
  }
}

async function removeOurEntry(dest: string): Promise<void> {
  const st = await fs.lstat(dest);
  if (st.isSymbolicLink()) {
    await fs.unlink(dest);
    return;
  }
  await fs.rm(dest, { recursive: true, force: true });
}

export interface TeamSkillSay {
  log: (message: string) => void;
  warn: (message: string) => void;
}

function destNote(runtime: string | null | undefined, dest: { label: string; machineWide: boolean }): string {
  return dest.machineWide
    ? `${dest.label}（全机生效，本机所有 ${runtimeFamily(runtime)} 节点）`
    : `${dest.label}（仅本节点）`;
}

/** 启动时把 ~/.anet/skills/<name> 链进该运行时的用户级目录。同名且不是我们建的，不覆盖。 */
export async function installTeamSkills(runtime: string | null | undefined, ctx: SkillContext, say: TeamSkillSay = { log() {}, warn() {} }): Promise<void> {
  const dest = teamSkillDest(runtime, ctx);
  if (!dest) return;
  const teamDir = teamSkillsDir(ctx);
  const sources = await teamSkillSources(teamDir);
  if (sources.length === 0 && !(await pathExists(dest.dir))) return;
  if (sources.length > 0) await fs.mkdir(dest.dir, { recursive: true });
  const note = destNote(runtime, dest);
  const live = new Set(sources.map((s) => s.src));
  for (const { name, src } of sources) {
    const hiddenBy = await projectHasSkill(runtime, ctx, name);
    if (hiddenBy) say.warn(`[skills] 团队技能 ${name} 被 ${hiddenBy}/${name} 挡住`);
    const target = path.join(dest.dir, name);
    if (!(await pathExists(target))) {
      const kind = await placeTeamLink(src, target);
      say.log(`[skills] 团队技能 ${name} 已${kind === "copied" ? "复制" : "链"}到 ${note}`);
      continue;
    }
    if (!(await isOurTeamEntry(target, teamDir))) {
      say.warn(`[skills] 团队技能 ${name} 未覆盖 ${dest.label}/${name}：目标已存在，且不是指向团队目录的链接`);
      continue;
    }
    const pointed = await ourEntrySource(target, teamDir);
    // 链接已经指向这份源:不用动。复制件(Windows 无权限建链接时的退路)每次启动按源刷新。
    if (pointed === src && !(await hasTeamCopyMarker(target))) continue;
    await removeOurEntry(target);
    const kind = await placeTeamLink(src, target);
    say.log(`[skills] 团队技能 ${name} 已${kind === "copied" ? "复制" : "链"}到 ${note}`);
  }
  if (!(await pathExists(dest.dir))) return;
  for (const name of await fs.readdir(dest.dir)) {
    if (!isValidSkillName(name) || name.startsWith(".")) continue;
    const target = path.join(dest.dir, name);
    if (!(await isOurTeamEntry(target, teamDir))) continue;
    const pointed = await ourEntrySource(target, teamDir);
    if (pointed && live.has(pointed) && await pathExists(pointed)) continue;
    await removeOurEntry(target);
    say.log(`[skills] 已移除失效的团队链接 ${dest.label}/${name}`);
  }
}

export async function teamSkillWarnings(runtime: string | null | undefined, ctx: SkillContext): Promise<string[]> {
  const dest = teamSkillDest(runtime, ctx);
  if (!dest) return [];
  const teamDir = teamSkillsDir(ctx);
  const warnings: string[] = [];
  for (const { name } of await teamSkillSources(teamDir)) {
    const hiddenBy = await projectHasSkill(runtime, ctx, name);
    if (hiddenBy) warnings.push(`团队技能 ${name} 被 ${hiddenBy}/${name} 挡住`);
    const target = path.join(dest.dir, name);
    if (await pathExists(target) && !(await isOurTeamEntry(target, teamDir))) {
      warnings.push(`团队技能 ${name} 未覆盖 ${dest.label}/${name}：目标已存在，且不是指向团队目录的链接`);
    }
  }
  return warnings;
}

export async function skillView(runtime: string | null | undefined, ctx: SkillContext): Promise<{ skills: SkillSummary[]; roots: string[]; warnings: string[] }> {
  return {
    skills: await listSkills(runtime, ctx),
    roots: skillRootsForRuntime(runtime, ctx).map((root) => root.label),
    warnings: await teamSkillWarnings(runtime, ctx),
  };
}
