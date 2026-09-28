// Codex 节点的 CODEX_HOME。只展示，和 project_dir 同级。
// 形状不合法就丢掉这一格，绝不能让整份 report_status 失败 —— 那会让节点掉线。

const CONTROL = /[\u0000-\u001f\u007f]/;
const TOKEN = /(?:ntok_|atok_|sk-|bearer\s)/i;

/** 绝对路径，且不像一枚令牌。相对路径、空串、超长、控制字符都返回 null。 */
export function sanitizeCodexHome(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 1024) return null;
  if (CONTROL.test(value) || TOKEN.test(value)) return null;
  if (!(value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))) return null;
  return value;
}
