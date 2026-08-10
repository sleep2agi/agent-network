import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChannelAttachmentPaths,
  channelAttachmentCacheDir,
  downloadChannelImageAttachments,
} from "./channel-attachments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude channel attachments", () => {
  test("cache roots are alias-isolated even for path-shaped aliases", () => {
    const root = "/tmp/channel-cache-root";
    const first = channelAttachmentCacheDir(root, "owner-a");
    const second = channelAttachmentCacheDir(root, "owner-b");
    const hostile = channelAttachmentCacheDir(root, "../../escape");
    expect(first).not.toBe(second);
    expect(first.startsWith(`${root}/.anet/cache/attachments/channel/`)).toBe(true);
    expect(hostile.startsWith(`${root}/.anet/cache/attachments/channel/`)).toBe(true);
    expect(hostile).not.toContain("../");
  });

  test("downloads an authenticated Dashboard PNG and surfaces an owner-local Read path", async () => {
    const root = mkdtempSync(join(tmpdir(), "channel-attachment-"));
    roots.push(root);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const requests: Array<{ url: string; auth: string | null }> = [];
    const result = await downloadChannelImageAttachments({
      meta: { attachments: [{ type: "image", file_id: "file_png_520", name: "screen.png", mime: "image/png", size: png.length }] },
    }, {
      hubUrl: "http://hub.invalid/",
      authToken: "ntok_test_secret",
      cacheDir: channelAttachmentCacheDir(root, "TMCode负责人"),
      fetch: (async (input, init) => {
        requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
        return new Response(png, { headers: { "content-length": String(png.length), "content-type": "image/png" } });
      }) as typeof fetch,
    });

    expect(result.failures).toEqual([]);
    expect(result.paths).toHaveLength(1);
    expect(requests).toEqual([{ url: "http://hub.invalid/api/files/file_png_520", auth: "Bearer ntok_test_secret" }]);
    expect(existsSync(result.paths[0]!)).toBe(true);
    expect([...readFileSync(result.paths[0]!)]).toEqual([...png]);
    expect(statSync(result.paths[0]!).mode & 0o777).toBe(0o600);
    const content = appendChannelAttachmentPaths("[Dashboard 附件] image.png", result.paths);
    expect(content).toContain("[Dashboard 附件] image.png");
    expect(content).toContain(JSON.stringify(result.paths[0]));
    expect(content).toContain("Use the Read tool");
    expect(content).not.toContain("ntok_test_secret");
  });

  test("downloads an authenticated non-image file for the Read-capable channel", async () => {
    const root = mkdtempSync(join(tmpdir(), "channel-file-attachment-"));
    roots.push(root);
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const result = await downloadChannelImageAttachments({
      meta: { attachments: [{ type: "file", file_id: "file_pdf_365", name: "brief.pdf", mime: "application/pdf", size: pdf.length }] },
    }, {
      hubUrl: "http://hub.invalid",
      authToken: "ntok_test",
      cacheDir: channelAttachmentCacheDir(root, "reader"),
      fetch: (async () => new Response(pdf, {
        headers: { "content-length": String(pdf.length), "content-type": "application/pdf" },
      })) as typeof fetch,
    });

    expect(result.failures).toEqual([]);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toEndWith(".pdf");
    expect([...readFileSync(result.paths[0]!)]).toEqual([...pdf]);
    expect(statSync(result.paths[0]!).mode & 0o777).toBe(0o600);
  });

  test("download failure preserves the original text and exposes no token", async () => {
    const root = mkdtempSync(join(tmpdir(), "channel-attachment-fail-"));
    roots.push(root);
    const result = await downloadChannelImageAttachments({
      meta_json: JSON.stringify({ attachments: [{ type: "image", file_id: "file_missing_520", mime: "image/png" }] }),
    }, {
      hubUrl: "http://hub.invalid",
      authToken: "ntok_must_not_leak",
      cacheDir: channelAttachmentCacheDir(root, "owner"),
      fetch: (async () => new Response("missing", { status: 404 })) as typeof fetch,
    });
    expect(result.paths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).not.toContain("ntok_must_not_leak");
    expect(appendChannelAttachmentPaths("original dashboard text", result.paths)).toBe("original dashboard text");
  });

  test("rejects traversal-shaped file ids before any fetch", async () => {
    let fetches = 0;
    const result = await downloadChannelImageAttachments({
      meta: { attachments: [{ type: "image", file_id: "../../etc/passwd", mime: "image/png" }] },
    }, {
      hubUrl: "http://hub.invalid",
      authToken: "ntok_test",
      cacheDir: "/tmp/unused-channel-attachment-test",
      fetch: (async () => { fetches++; return new Response(); }) as typeof fetch,
    });
    expect(fetches).toBe(0);
    expect(result.failures[0]?.code).toBe("invalid_file_id");
  });

  test("does not trust a sender-provided local path", async () => {
    const root = mkdtempSync(join(tmpdir(), "channel-attachment-untrusted-path-"));
    roots.push(root);
    const local = join(root, "sender-controlled.png");
    Bun.write(local, "not trusted");
    let fetches = 0;
    const result = await downloadChannelImageAttachments({
      meta: { attachments: [{ type: "image", path: local, mime: "image/png" }] },
    }, {
      hubUrl: "http://hub.invalid",
      authToken: "ntok_test",
      cacheDir: join(root, "cache"),
      fetch: (async () => { fetches++; return new Response(); }) as typeof fetch,
    });
    expect(fetches).toBe(0);
    expect(result.paths).toEqual([]);
    expect(result.failures[0]?.code).toBe("no_download_identity");
  });
});
