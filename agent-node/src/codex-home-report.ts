// 只在 Codex 运行时上报 CODEX_HOME。别的运行时就算环境里有这个变量也不发。
// 旧 hub 的 report_status 对象不是 strict，多出来的键会被丢掉，节点不会因此掉线。

const CODEX_RUNTIMES = new Set(["codex", "codex-app-server"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const TOKEN = /(?:ntok_|atok_|sk-|bearer\s)/i;

export function reportedCodexHome(runtime: string, raw: unknown): string | undefined {
  if (!CODEX_RUNTIMES.has(runtime)) return undefined;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > 1024) return undefined;
  if (CONTROL.test(value) || TOKEN.test(value)) return undefined;
  if (!(value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))) return undefined;
  return value;
}

export function reportedCodexHomeField(runtime: string, raw: unknown): { codex_home: string } | Record<string, never> {
  const home = reportedCodexHome(runtime, raw);
  return home ? { codex_home: home } : {};
}
