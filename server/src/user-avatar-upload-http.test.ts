import { expect, test } from "bun:test";
import { register, createNetworkTokenForNode, addNetworkMember } from "./auth.js";
import { db } from "./db.js";
import { inspectAvatarImage, MAX_AVATAR_BYTES } from "./user-avatar-image.js";
import { deflateSync } from "node:zlib";

// 1×1 PNG（透明）。只用来走真实 multipart → 真实文件头校验。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** 真的 8-bit RGBA PNG：IHDR + 一段 zlib 压缩的扫描行 + IEND，CRC 全对。 */
function realPng(width: number, height: number): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((1 + width * 4) * height); // 每行前面一个 filter 字节 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}


/** CRC 全对、但 IDAT 内容非法的 PNG：用来证明「结构通过 ≠ 图像有效」。 */
function pngWithIdat(idat: Buffer, opts: { colorType?: number; bitDepth?: number; width?: number; height?: number } = {}): Buffer {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width ?? 1, 0); ihdr.writeUInt32BE(opts.height ?? 1, 4);
  ihdr[8] = opts.bitDepth ?? 8; ihdr[9] = opts.colorType ?? 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("account avatar upload: user token only, PNG limits, visibility by shared network, revoke, atomic replace", async () => {
  const a = register("avup_alice", "AvatarUpload1!");
  const b = register("avup_bob", "AvatarUpload1!");
  const outsider = register("avup_outsider", "AvatarUpload1!");
  expect(a.ok && b.ok && outsider.ok).toBe(true);
  expect(addNetworkMember(a.network_id!, b.user!.user_id, "member").ok).toBe(true);
  const node = createNetworkTokenForNode(a.user!.user_id, a.network_id!, "avup_alice", "avup_node");
  expect(node.ok).toBe(true);

  const { bootServer } = await import("./server.js");
  const hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${hub.port}`;

  const upload = async (token: string | null, bytes: Buffer, fieldName = "file", extra?: [string, string]) => {
    const form = new FormData();
    form.append(fieldName, new Blob([bytes], { type: "image/png" }), "a.png");
    if (extra) form.append(extra[0], extra[1]);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api/auth/me/avatar/upload`, { method: "POST", headers, body: form });
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as any };
  };
  const getAvatar = async (token: string | null, path: string) => {
    const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  };

  try {
    // 前置：陌生人之间没有共享网络。
    expect(db.get("SELECT 1 AS ok FROM network_members m WHERE m.user_id=?1 AND m.network_id=?2", outsider.user!.user_id, a.network_id!)).toBeNull();

    // 匿名/节点令牌都不是「本人」。
    expect((await upload(null, PNG_1X1)).status).toBe(401);
    expect((await upload(node.token!, PNG_1X1)).status).toBe(403);

    // 畸形输入：非 PNG、超边长、空、多字段、非 multipart。
    expect((await upload(a.token!, Buffer.from("not a png"))).body.error).toBe("invalid_image");
    expect((await upload(a.token!, realPng(600, 600))).body.reason).toBe("too_big");
    expect((await upload(a.token!, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(a.token!, PNG_1X1, "other")).status).toBe(400);
    expect((await upload(a.token!, PNG_1X1, "file", ["avatar_url", "/etc/passwd"])).status).toBe(400);
    const notMultipart = await fetch(`${base}/api/auth/me/avatar/upload`, {
      method: "POST", headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" }, body: "{}",
    });
    expect(notMultipart.status).toBe(415);

    // 成功：URL 由 Hub 发，version 只含 URL 安全字符。
    const ok1 = await upload(a.token!, PNG_1X1);
    expect(ok1.status).toBe(200);
    expect(ok1.body.ok).toBe(true);
    expect(ok1.body.user_id).toBe(a.user!.user_id);
    expect(ok1.body.avatar_url).toMatch(new RegExp(`^/api/users/${a.user!.user_id}/avatar/[A-Za-z0-9_-]{1,128}\\.png$`));

    const first = await getAvatar(a.token!, ok1.body.avatar_url);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("location")).toBeNull();
    expect(first.bytes.byteLength).toBe(PNG_1X1.byteLength);

    // 同网络成员可读；不同网络的人读不到（与不存在同码，避免探测）。
    expect((await getAvatar(b.token!, ok1.body.avatar_url)).status).toBe(200);
    expect((await getAvatar(outsider.token!, ok1.body.avatar_url)).status).toBe(404);
    expect((await getAvatar(null, ok1.body.avatar_url)).status).toBe(401);
    expect((await getAvatar(node.token!, ok1.body.avatar_url)).status).toBe(403);
    expect((await getAvatar(a.token!, `/api/users/${a.user!.user_id}/avatar/nope..%2F.png`)).status).toBe(404);

    // 撤权后立刻读不到。
    expect(db.run("DELETE FROM network_members WHERE user_id=?1 AND network_id=?2", [b.user!.user_id, a.network_id!]).changes).toBeGreaterThan(0);
    expect((await getAvatar(b.token!, ok1.body.avatar_url)).status).toBe(404);

    // 「CRC 正确但图像数据非法」也必须 400：结构通过不等于可解码。
    const beforeInvalid = db.get<{ version: string; bytes: number }>(
      "SELECT version, bytes FROM user_avatar_uploads WHERE user_id=?1", a.user!.user_id);
    expect((await upload(a.token!, pngWithIdat(Buffer.alloc(0)))).body.reason).toBe("bad_image");
    expect((await upload(a.token!, pngWithIdat(Buffer.from("not-a-zlib-stream")))).body.reason).toBe("bad_image");
    // 解压成功但扫描行长度不符（声明 2×2 RGBA，实际只给 1×1）
    expect((await upload(a.token!, pngWithIdat(deflateSync(Buffer.alloc(5)), { width: 2, height: 2 }))).body.reason).toBe("bad_image");
    const afterInvalid = db.get<{ version: string; bytes: number }>(
      "SELECT version, bytes FROM user_avatar_uploads WHERE user_id=?1", a.user!.user_id);
    expect(afterInvalid).toEqual(beforeInvalid);

    // 原子替换：一次失败的上传不能把上一张弄丢；成功后旧 version 立刻 404。
    const beforeBad = db.get<{ version: string }>("SELECT version FROM user_avatar_uploads WHERE user_id=?1", a.user!.user_id);
    expect((await upload(a.token!, Buffer.from("broken"))).status).toBe(400);
    expect(db.get<{ version: string }>("SELECT version FROM user_avatar_uploads WHERE user_id=?1", a.user!.user_id)!.version).toBe(beforeBad!.version);
    expect((await getAvatar(a.token!, ok1.body.avatar_url)).status).toBe(200);

    const ok2 = await upload(a.token!, realPng(512, 512));
    expect(ok2.status).toBe(200);
    expect(ok2.body.avatar_url).not.toBe(ok1.body.avatar_url);
    expect((await getAvatar(a.token!, ok1.body.avatar_url)).status).toBe(404);
    expect((await getAvatar(a.token!, ok2.body.avatar_url)).status).toBe(200);
    expect(db.get<{ width: number }>("SELECT width FROM user_avatar_uploads WHERE user_id=?1", a.user!.user_id)!.width).toBe(512);
  } finally {
    db.run("DELETE FROM user_avatar_uploads WHERE user_id IN (?1, ?2, ?3)", [a.user!.user_id, b.user!.user_id, outsider.user!.user_id]);
    await hub.stop?.();
  }
});

test("image inspector: signature, shape and size limits", () => {
  expect(inspectAvatarImage(PNG_1X1)).toEqual({ ok: true, width: 1, height: 1 });
  expect(inspectAvatarImage(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
  expect(inspectAvatarImage(new Uint8Array(10))).toEqual({ ok: false, reason: "not_png" });
  expect(inspectAvatarImage(Buffer.from(realPng(16, 16).subarray(0, 20)))).toEqual({ ok: false, reason: "truncated" });
  expect(inspectAvatarImage(Buffer.from(realPng(16, 16).subarray(0, 40)))).toEqual({ ok: false, reason: "truncated" });
  const truePng = realPng(16, 16);
  const corrupt = Buffer.from(truePng); corrupt[corrupt.length - 20] ^= 0xff;
  expect(inspectAvatarImage(corrupt).ok).toBe(false);
  expect(inspectAvatarImage(realPng(513, 16))).toEqual({ ok: false, reason: "too_big" });
  const zeroWide = realPng(0, 1); // 宽 0 + 正确 CRC：专证 bad_dimensions 而不是 bad_crc
  expect(inspectAvatarImage(zeroWide)).toEqual({ ok: false, reason: "bad_dimensions" });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]);
  expect(inspectAvatarImage(jpeg)).toEqual({ ok: false, reason: "not_png" });
  expect(inspectAvatarImage(Buffer.alloc(MAX_AVATAR_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
});
