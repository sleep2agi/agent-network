// Fake npm registry for selftest.sh — simulates the window right after a publish in which the
// dist-tag already points at the new version but the tarball is not servable yet (404).
//   env TGZ=<path to package tarball> PKG=<name> VER=<version> PORT=<port>
//   GET /__window?ms=N   → the tarball 404s for the next N ms (N=-1: forever)
//   GET /<pkg packument> → { dist-tags: { preview: VER }, versions: { VER: … } }
//   GET /tarball.tgz     → 404 while the window is open, else the tarball
import { readFileSync } from "fs";
import { createHash } from "crypto";

const tgz = readFileSync(process.env.TGZ!);
const pkg = process.env.PKG!;
const ver = process.env.VER!;
const port = Number(process.env.PORT || 4873);
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const shasum = createHash("sha1").update(tgz).digest("hex");
let openUntil = 0; // epoch ms; -1 = forever

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    const path = decodeURIComponent(u.pathname);
    if (path === "/__window") {
      const ms = Number(u.searchParams.get("ms") || 0);
      openUntil = ms < 0 ? -1 : Date.now() + ms;
      return new Response("ok\n");
    }
    if (path === "/tarball.tgz") {
      if (openUntil === -1 || Date.now() < openUntil) return new Response('{"error":"Not found"}', { status: 404 });
      return new Response(tgz, { headers: { "content-type": "application/octet-stream" } });
    }
    if (path === "/" + pkg) {
      const base = `http://127.0.0.1:${port}`;
      return Response.json({
        name: pkg,
        "dist-tags": { preview: ver, latest: ver },
        versions: {
          [ver]: { name: pkg, version: ver, bin: { anet: "bin/anet.js" }, dist: { tarball: `${base}/tarball.tgz`, integrity, shasum } },
        },
      });
    }
    return new Response('{"error":"Not found"}', { status: 404 });
  },
});
console.log(`fake registry on ${port}`);
