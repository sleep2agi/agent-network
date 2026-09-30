// anet 登录 / 注册时自报的 client_label(hub 原样存进 api_tokens.client_label,app 的「设置 → 账号 → 登录设备」按它分组)。
//
// 为什么(2026-09-30):生产 hub 上 admin 有 2617 条登录会话,client_label 全空 —— 命令行和脚本的密码登录每次都新签一条,
// 在「登录设备」里只能显示成「未命名(多为脚本 / 命令行)」,也分不清是哪台机器、哪个命令建的。
// hub 早就收 body.client_label(server.ts login / register),只是 anet 从来没发。
//
// 形如「anet 2.5.0 · DEV-box · login」:工具名 + 版本 · 主机名 · 子命令。不翻译(别的设备、别的语言都会看到)。
// hub 截到 64 字符并去掉控制字符;这里先按同样的规则收好,免得最有用的子命令被截掉:主机名最长 24,且先让位。
export const CLIENT_LABEL_MAX = 64;
const HOST_MAX = 24;

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export function anetClientLabel(env: { version?: string | null; host?: string | null; command: string }): string {
  const head = `anet ${clean(env.version ?? "") || "dev"} · `;
  const tail = ` · ${clean(env.command) || "cli"}`;
  // 先让主机名让位(它最长、也最不关键),子命令留在最后能被看到;最少留 8 个字符。
  const room = Math.max(8, Math.min(HOST_MAX, CLIENT_LABEL_MAX - head.length - tail.length));
  let host = clean(env.host ?? "") || "unknown-host";
  if (host.length > room) host = `${host.slice(0, room - 1)}…`;
  const label = head + host + tail;
  return label.length > CLIENT_LABEL_MAX ? `${label.slice(0, CLIENT_LABEL_MAX - 1)}…` : label;
}
