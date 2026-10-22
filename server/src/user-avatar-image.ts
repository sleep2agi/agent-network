// #725-adjacent? No: Hub 专用账号头像上传（通信Mac马 交付单）。
//
// 头像不是普通附件：它必须 PNG、边长 ≤512、≤8 MiB，且只能由本人用自己的
// **用户令牌**写入；读取按「人类资料可见性」（本人或共享网络的合法成员）判定，
// 不借用 /api/files 的附件 ACL（那是按网络/会话/DM 作用域判的，语义不同）。
//
// 这个模块只做纯校验，便于单测与复用；HTTP 与落库在 server.ts。
import { inflateSync } from "node:zlib";

// 校验强度：结构（签名/chunk/CRC）+ 真实解码（IDAT 解压且扫描行长度与 IHDR 相符）。

export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** 客户端会把图重编码到最长边 512；服务端独立复核这条上限。 */
export const MAX_AVATAR_EDGE = 512;
/** version 只允许 URL 安全字符，长度有界（避免拼路径时引入 `.`、`/`）。 */
export const AVATAR_VERSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const AVATAR_FIELD = "file";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type AvatarImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "empty" | "too_large" | "not_png" | "truncated" | "bad_dimensions" | "too_big" | "bad_crc" | "bad_image" | "interlaced_unsupported" };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };


/** 标准 CRC-32（PNG 每个 chunk 的尾部）。表只建一次。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * PNG 结构校验：签名 + 逐个 chunk 的 CRC + 必须有 IDAT 且以 IEND 结尾。
 *
 * 只信任「结构完整」而不是「声明了什么」：截断的 33/40 字节、零填充的伪图
 * （IHDR 对但 CRC 与 IDAT 缺失）都会被拒；合法用户因此不能把已有头像
 * 覆盖成一张显示不出来的图。
 */
export function inspectAvatarImage(input: Uint8Array): AvatarImageCheck {
  if (input.byteLength === 0) return { ok: false, reason: "empty" };
  if (input.byteLength > MAX_AVATAR_BYTES) return { ok: false, reason: "too_large" };
  for (let i = 0; i < PNG_SIGNATURE.length && i < input.byteLength; i++) {
    if (input[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: "not_png" };
  }
  if (input.byteLength < 45) return { ok: false, reason: "truncated" }; // 签名 + IHDR(25) + 最小 IEND(12)

  let pos = 8;
  let width = 0;
  let height = 0;
  let sawIHDR = false;
  let idatChunks = 0;
  let sawIEND = false;
  let sawPLTE = false;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];

  while (pos + 12 <= input.byteLength) {
    const length = be32(input, pos);
    const type = String.fromCharCode(input[pos + 4], input[pos + 5], input[pos + 6], input[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > input.byteLength) return { ok: false, reason: "truncated" };
    if (!sawIHDR && type !== "IHDR") return { ok: false, reason: "not_png" };
    if ((crc32(input.subarray(pos + 4, dataEnd)) >>> 0) !== be32(input, dataEnd)) {
      return { ok: false, reason: "bad_crc" };
    }
    if (type === "IHDR") {
      if (sawIHDR || length !== 13) return { ok: false, reason: "not_png" };
      width = be32(input, dataStart);
      height = be32(input, dataStart + 4);
      bitDepth = input[dataStart + 8];
      colorType = input[dataStart + 9];
      const compression = input[dataStart + 10];
      const filter = input[dataStart + 11];
      const interlace = input[dataStart + 12];
      // 只接受规范的 IHDR 取值组合；非法组合的图多数解码器也会拒绝。
      const legalDepth: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!legalDepth[colorType]?.includes(bitDepth)) return { ok: false, reason: "not_png" };
      if (compression !== 0 || filter !== 0) return { ok: false, reason: "not_png" };
      // Adam7 隔行扫描的扫描行布局与逐行校验不同：本实现不支持，明确拒收而不是错算长度。
      if (interlace === 1) return { ok: false, reason: "interlaced_unsupported" };
      if (width === 0 || height === 0) return { ok: false, reason: "bad_dimensions" };
      if (width > MAX_AVATAR_EDGE || height > MAX_AVATAR_EDGE) return { ok: false, reason: "too_big" };
      sawIHDR = true;
    } else if (type === "PLTE") {
      if (length === 0 || length % 3 !== 0) return { ok: false, reason: "not_png" };
      sawPLTE = true;
    } else if (type === "IDAT") {
      idatChunks++;
      idat.push(input.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0) return { ok: false, reason: "not_png" };
      if (crcEnd !== input.byteLength) return { ok: false, reason: "not_png" };
      sawIEND = true;
      break;
    }
    pos = crcEnd;
  }

  if (!sawIHDR || !sawIEND) return { ok: false, reason: "truncated" };
  if (idatChunks === 0) return { ok: false, reason: "not_png" };
  // 调色板图必须带 PLTE，否则解码器无从取色。
  if (colorType === 3 && !sawPLTE) return { ok: false, reason: "not_png" };
  // CRC 只证明「容器没坏」，不证明 IDAT 里是图像数据：真解一次 zlib，并核对
  // 解压后长度正好等于 IHDR 声明的扫描行总长（每行 1 字节 filter + 像素字节）。
  const bytesPerRow = Math.ceil((width * (CHANNELS[colorType] ?? 0) * bitDepth) / 8);
  const expected = height * (1 + bytesPerRow);
  let raw: Uint8Array;
  try {
    const merged = Buffer.concat(idat.map(part => Buffer.from(part)));
    raw = new Uint8Array(inflateSync(merged, { maxOutputLength: expected + 1024 }));
  } catch {
    return { ok: false, reason: "bad_image" };
  }
  if (raw.byteLength !== expected) return { ok: false, reason: "bad_image" };
  for (let row = 0; row < height; row++) {
    if (raw[row * (1 + bytesPerRow)] > 4) return { ok: false, reason: "bad_image" }; // 过滤器 0..4
  }
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
