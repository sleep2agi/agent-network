/**
 * claude-code-cli 节点(node-server 通道)回复里的「本机文件链接」→ 自动上传成附件。
 * 与 agent-node 的 runtime/reply-file-links.ts 同一形状(两个包不能互相 import,各放一份纯逻辑)。
 * 2026-09-15 真机:外部团队节点 两条带 pptx 的回复到 hub 时附件为空,人只看到「点卡片下载」四个字。
 */
export const REPLY_LOCAL_LINK_MAX = 6;

export interface LocalLink { readonly raw: string; readonly label: string; readonly path: string }

/** 只认 markdown 链接且目标像本机绝对路径(`/…` 或 `file:///…`);http(s)、/api/files/… 不算。 */
export function findLocalLinks(text: string): LocalLink[] {
  const out: LocalLink[] = [];
  const re = /\[([^\]\n]{1,200})\]\(([^()\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[2];
    let path: string | null = null;
    if (t.startsWith("file:///")) path = decodeURIComponent(t.slice("file://".length));
    else if (t.startsWith("/") && !t.startsWith("/api/") && !t.startsWith("//")) path = t;
    if (!path) continue;
    out.push({ raw: m[0], label: m[1], path });
    if (out.length >= REPLY_LOCAL_LINK_MAX) break;
  }
  return out;
}

export interface UploadedRef { file_id: string; name: string; mime?: string; size?: number }

/** 上传成功的链接目标改成 /api/files/<id>(客户端按附件卡片渲染),失败的在标签后注明原因;返回 attachments 数组。 */
export function rewriteLocalLinks(
  text: string,
  results: ReadonlyArray<{ link: LocalLink; uploaded?: UploadedRef; reason?: string }>,
): { text: string; attachments: Array<{ type: "file"; file_id: string; name?: string; mime?: string; size?: number }> } {
  let out = text;
  const attachments: Array<{ type: "file"; file_id: string; name?: string; mime?: string; size?: number }> = [];
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

/** 端到端(上传函数注入,失败抛错即可):没有本机链接时原样返回、零副作用。 */
export async function attachLocalLinks(
  text: string,
  upload: (path: string) => Promise<UploadedRef>,
): Promise<{ text: string; attachments: Array<{ type: "file"; file_id: string; name?: string; mime?: string; size?: number }>; uploaded: number; failed: number }> {
  const links = findLocalLinks(text);
  if (links.length === 0) return { text, attachments: [], uploaded: 0, failed: 0 };
  const results: Array<{ link: LocalLink; uploaded?: UploadedRef; reason?: string }> = [];
  for (const link of links) {
    try { results.push({ link, uploaded: await upload(link.path) }); }
    catch (e: any) { results.push({ link, reason: String(e?.message ?? e).slice(0, 160) }); }
  }
  const rw = rewriteLocalLinks(text, results);
  return { ...rw, uploaded: results.filter((r) => r.uploaded).length, failed: results.filter((r) => !r.uploaded).length };
}
