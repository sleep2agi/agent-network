/**
 * 回复里的「本机文件链接」→ 自动上传成附件。
 *
 * 2026-09-14 真机:TMA中转牛 回复「[下载测试报告(PDF)](/data/workspaces/…/report.pdf)」—— 那是它自己机器上的路径,hub 上没有
 * 这个文件,桌面端只剩一行文字,人看到的是「发文件失败」。agent 想给人发文件,此前只有手工 curl /api/upload 一条路,
 * 没有 runtime 会自动做,所以每个 agent 都会这么写。这里在 sendReply 前把这类链接找出来、校验、上传、改写成
 * `/api/files/<id>` 并附上 attachments;上传不了的在链接后注明原因,不吞。纯逻辑在此,上传由调用方注入。
 */
import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";

export const REPLY_FILE_MAX_BYTES = 12 * 1024 * 1024; // = hub MAX_UPLOAD_BYTES
export const REPLY_FILE_MAX_COUNT = 6;

export interface LocalFileLink {
  /** 整个 `[label](target)` 原文,用于替换。 */
  readonly raw: string;
  readonly label: string;
  readonly target: string;
  /** 解析出的本地绝对路径(去掉 file:// 前缀;不解析相对路径)。 */
  readonly path: string;
}

/** 只认 markdown 链接且目标像本机绝对路径:`/…` 或 `file:///…`。http(s)、/api/files/… 不算。 */
export function findLocalFileLinks(text: string): LocalFileLink[] {
  const out: LocalFileLink[] = [];
  const re = /\[([^\]\n]{1,200})\]\(([^()\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const target = m[2];
    let path: string | null = null;
    if (target.startsWith("file:///")) path = decodeURIComponent(target.slice("file://".length));
    else if (target.startsWith("/") && !target.startsWith("/api/") && !target.startsWith("//")) path = target;
    if (!path || !isAbsolute(path)) continue;
    out.push({ raw: m[0], label: m[1], target, path });
    if (out.length >= REPLY_FILE_MAX_COUNT) break;
  }
  return out;
}

export type LocalFileCheck =
  | { ok: true; realPath: string; name: string; size: number; mime: string }
  | { ok: false; reason: string };

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".htm": "text/html",
  ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function mimeFor(name: string): string { return MIME[extname(name).toLowerCase()] ?? "application/octet-stream"; }

/** 路径必须在允许的根目录之内(realpath 之后比,symlink 逃逸不算)、是普通文件、≤ 12 MiB。 */
export function checkLocalFile(path: string, roots: readonly string[], maxBytes = REPLY_FILE_MAX_BYTES): LocalFileCheck {
  let real: string;
  try { real = realpathSync(path); } catch { return { ok: false, reason: "文件不存在" }; }
  const inside = roots.some((r) => {
    let rr: string; try { rr = realpathSync(r); } catch { return false; }
    return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep);
  });
  if (!inside) return { ok: false, reason: "不在节点的工作目录或家目录内" };
  let st; try { st = statSync(real); } catch { return { ok: false, reason: "无法读取" }; }
  if (!st.isFile()) return { ok: false, reason: "不是普通文件" };
  if (st.size === 0) return { ok: false, reason: "空文件" };
  if (st.size > maxBytes) return { ok: false, reason: `超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限` };
  const name = basename(real);
  return { ok: true, realPath: real, name, size: st.size, mime: mimeFor(name) };
}

export interface UploadedFile { file_id: string; name: string; mime: string; size: number }
export interface ReplyAttachment { type: "file"; file_id: string; name: string; mime: string; size: number }

/** 把上传成功的链接目标换成 `/api/files/<id>`(桌面端按附件卡片渲染),失败的在标签后注明原因。 */
export function rewriteReplyLinks(
  text: string,
  results: ReadonlyArray<{ link: LocalFileLink; uploaded?: UploadedFile; reason?: string }>,
): { text: string; attachments: ReplyAttachment[] } {
  let out = text;
  const attachments: ReplyAttachment[] = [];
  for (const r of results) {
    if (r.uploaded) {
      out = out.replace(r.link.raw, `[${r.link.label}](/api/files/${r.uploaded.file_id})`);
      attachments.push({ type: "file", file_id: r.uploaded.file_id, name: r.uploaded.name, mime: r.uploaded.mime, size: r.uploaded.size });
    } else {
      out = out.replace(r.link.raw, `${r.link.label}(文件未上传:${r.reason ?? "未知原因"};路径 ${r.link.path})`);
    }
  }
  return { text: out, attachments };
}

/** 端到端(上传函数注入):找链接 → 校验 → 上传 → 改写。没有本机链接时原样返回、零副作用。 */
export async function attachLocalFileLinks(
  text: string,
  deps: { roots: readonly string[]; upload: (file: { realPath: string; name: string; mime: string; size: number }) => Promise<UploadedFile> },
): Promise<{ text: string; attachments: ReplyAttachment[]; uploaded: number; failed: number }> {
  const links = findLocalFileLinks(text);
  if (links.length === 0) return { text, attachments: [], uploaded: 0, failed: 0 };
  const results: Array<{ link: LocalFileLink; uploaded?: UploadedFile; reason?: string }> = [];
  for (const link of links) {
    const check = checkLocalFile(link.path, deps.roots);
    if (!check.ok) { results.push({ link, reason: check.reason }); continue; }
    try { results.push({ link, uploaded: await deps.upload(check) }); }
    catch (e: any) { results.push({ link, reason: `上传失败(${e?.message ?? e})` }); }
  }
  const rewritten = rewriteReplyLinks(text, results);
  return { ...rewritten, uploaded: results.filter((r) => r.uploaded).length, failed: results.filter((r) => !r.uploaded).length };
}
