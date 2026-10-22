// #725-adjacent? No: Hub 专用账号头像上传（通信Mac马 交付单）。
//
// 头像不是普通附件：它必须 PNG、边长 ≤512、≤8 MiB，且只能由本人用自己的
// **用户令牌**写入；读取按「人类资料可见性」（本人或共享网络的合法成员）判定，
// 不借用 /api/files 的附件 ACL（那是按网络/会话/DM 作用域判的，语义不同）。
//
// 这个模块只做纯校验，便于单测与复用；HTTP 与落库在 server.ts。

export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** 客户端会把图重编码到最长边 512；服务端独立复核这条上限。 */
export const MAX_AVATAR_EDGE = 512;
/** version 只允许 URL 安全字符，长度有界（避免拼路径时引入 `.`、`/`）。 */
export const AVATAR_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const AVATAR_FIELD = "file";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type AvatarImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "empty" | "too_large" | "not_png" | "truncated" | "bad_dimensions" | "too_big" };

function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** PNG 结构：8 字节签名 + 首个 chunk 必须是 IHDR（13 字节数据）。 */
export function inspectAvatarImage(input: Uint8Array): AvatarImageCheck {
  if (input.byteLength === 0) return { ok: false, reason: "empty" };
  if (input.byteLength > MAX_AVATAR_BYTES) return { ok: false, reason: "too_large" };
  if (input.byteLength < 33) return { ok: false, reason: "truncated" };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (input[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: "not_png" };
  }
  // 第一个 chunk：length(4) type(4) data(13) crc(4)，type 必须是 IHDR。
  if (be32(input, 8) !== 13) return { ok: false, reason: "not_png" };
  const type = String.fromCharCode(input[12], input[13], input[14], input[15]);
  if (type !== "IHDR") return { ok: false, reason: "not_png" };
  const width = be32(input, 16);
  const height = be32(input, 20);
  if (width === 0 || height === 0) return { ok: false, reason: "bad_dimensions" };
  if (width > MAX_AVATAR_EDGE || height > MAX_AVATAR_EDGE) return { ok: false, reason: "too_big" };
  return { ok: true, width, height };
}

export function isValidAvatarVersion(value: unknown): value is string {
  return typeof value === "string" && AVATAR_VERSION_RE.test(value);
}

export function avatarUrl(userId: string, version: string): string {
  return `/api/users/${encodeURIComponent(userId)}/avatar/${version}.png`;
}

/** 只接受 multipart 里的单张图；多余字段一律拒绝，避免「顺手塞个 filename 覆盖路径」。 */
export function isMultipart(contentType: string | null): boolean {
  return !!contentType && /^multipart\/form-data\b/i.test(contentType);
}
