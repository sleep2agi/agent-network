import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd } from './project-key';

export type UsageWeek = { tokens: number; since: string; cost_usd?: number | null };
export function weekStart(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return { start: +d, since: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` };
}
function count(n: unknown): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw Error('invalid token count');
  return n;
}
export function claudeLog(id?: string) {
  return id && /^[a-zA-Z0-9_-]+$/.test(id) ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', encodeCwd(process.cwd()), `${id}.jsonl`) : undefined;
}
// A single active runtime session, never the user's entire project/account.
export async function readUsageLog(kind: 'claude'|'codex', file?: string | null, now = new Date()): Promise<UsageWeek|null> {
  if (!file) return null;
  try {
    const s = await stat(file); if (!s.isFile() || s.size > 128*1024*1024) return null;
    const {start, since} = weekStart(now);
    const messages = new Map<string, number>(); let prev = 0, measured = false, total = 0;
    const stream = createReadStream(file, { encoding: 'utf8' });
    try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (kind === 'codex' ? r.type !== 'event_msg' || r.payload?.type !== 'token_count' || !r.payload.info : r.type !== 'assistant') continue;
      const t = Date.parse(r.timestamp); if (!Number.isFinite(t)) return null;
      if (t > +now) continue;
      if (kind === 'codex') {
        const next = count(r.payload.info.total_token_usage?.total_tokens);
        if (next < prev) return null;
        if (t >= start) total += next-prev;
        prev = next; measured = true;
      } else {
        const u = r.message?.usage, id = r.message?.id;
        if (!u || !id) continue;
        if (t >= start) messages.set(id, count(u.input_tokens) + count(u.output_tokens) + count(u.cache_read_input_tokens ?? 0) + count(u.cache_creation_input_tokens ?? 0));
        measured = true;
      }
    } } finally { stream.destroy(); }
    for (const n of messages.values()) total += n;
    return measured ? { tokens: count(total), since } : null;
  } catch { return null; }
}

// Same local assistant accounting records as OpenCode stats; the CLI's
// project-wide filter cannot distinguish two nodes in the same workspace.
export async function openCodeWeek(file: string, session: string, v2: boolean, now = new Date()): Promise<UsageWeek|null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, {readOnly:true});
    try {
      const {since,start} = weekStart(now);
      const rows = db.prepare(`SELECT json_extract(data,'$.tokens') AS tokens, json_extract(data,'$.cost') AS cost FROM ${v2 ? 'session_message' : 'message'} WHERE session_id=? AND time_created BETWEEN ? AND ? AND ${v2 ? "type='assistant'" : "json_extract(data,'$.role')='assistant'"}`).all(session,start,+now);
      let tokens = 0, usd: number|null = 0;
      for (const r of rows) {
        const t = JSON.parse(String(r.tokens)); tokens += count(t.input)+count(t.output)+count(t.reasoning)+count(t.cache.read)+count(t.cache.write);
        if (typeof r.cost !== 'number' || !Number.isFinite(r.cost) || r.cost < 0) usd=null; else if (usd!==null) usd+=r.cost;
      }
      return rows.length ? {tokens:count(tokens), cost_usd:usd, since} : null;
    } finally { db.close(); }
  } catch { return null; }
}

// Frequent working/idle reports share one read. Never reuse across a week or session switch.
export function usageSampler() {
  let previous = '', expires = 0, result: Promise<UsageWeek|null> = Promise.resolve(null);
  return (scope: string, read: () => Promise<UsageWeek|null>) => {
    const key = `${weekStart().since}:${scope}`;
    if (previous !== key || Date.now() >= expires) {
      previous = key; expires = Date.now()+60_000; result = Promise.resolve().then(read).catch(() => null);
    }
    return result;
  };
}
