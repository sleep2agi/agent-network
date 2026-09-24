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
//    必须仍在该根目录的 realpath 之内(挡住软链接逃逸),且必须是普通文件、不超过上限。
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

/** 解析某根目录下某技能的 SKILL.md;不存在返回 null;越界 / 非普通文件抛错。 */
async function resolveSkillFile(root: SkillRoot, name: string): Promise<{ file: string; size: number } | null> {
  const rootReal = await realpathOrNull(root.dir);
  if (!rootReal) return null;
  const candidate = path.join(root.dir, name, "SKILL.md");
  const real = await realpathOrNull(candidate);
  if (!real) return null;
  if (!isInside(real, rootReal)) throw new Error(`skill ${name} resolves outside its skills directory`);
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
        resolved = await resolveSkillFile(root, name);
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
      out.push({ name, scope: root.scope, path_rel: `${root.label}/${name}/SKILL.md`, description });
    }
  }
  return out;
}

export interface SkillReadResult extends SkillSummary {
  content: string;
}

export async function readSkill(runtime: string | null | undefined, ctx: SkillContext, name: unknown): Promise<SkillReadResult> {
  if (!isValidSkillName(name)) throw new Error("invalid skill name");
  for (const root of skillRootsForRuntime(runtime, ctx)) {
    const resolved = await resolveSkillFile(root, name);
    if (!resolved) continue;
    if (resolved.size > SKILL_FILE_MAX_BYTES) {
      throw new Error(`skill ${name}: SKILL.md is ${resolved.size} bytes, over the ${SKILL_FILE_MAX_BYTES} byte limit`);
    }
    const content = await fs.readFile(resolved.file, "utf8");
    return { name, scope: root.scope, path_rel: `${root.label}/${name}/SKILL.md`, description: parseSkillDescription(content), content };
  }
  throw new Error(`skill not found: ${name}`);
}
