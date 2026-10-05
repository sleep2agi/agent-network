// Fake npm registry for tests/lib/install-published.test.sh — simulates the window right after a
// publish in which the dist-tag already points at the new version but the tarball is not servable
// yet (404). Plain node (no bun) so the host-side tests/lib meta job can run it too.
//   env TGZ=<path to package tarball> PKG=<name> VER=<version> PORT=<port>
//   GET /__window?ms=N   → the tarball 404s for the next N ms (N=-1: forever)
//   GET /<pkg packument> → { dist-tags: { preview: VER, latest: VER }, versions: { VER: … } }
//   GET /tarball.tgz     → 404 while the window is open, else the tarball
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const tgz = readFileSync(process.env.TGZ);
const pkg = process.env.PKG;
const ver = process.env.VER;
const port = Number(process.env.PORT || 4873);
const integrity = "sha512-" + createHash("sha512").update(tgz).digest("base64");
const shasum = createHash("sha1").update(tgz).digest("hex");
let openUntil = 0; // epoch ms; -1 = forever

const notFound = (res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"Not found"}');
};

createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = decodeURIComponent(u.pathname);
  if (path === "/__window") {
    const ms = Number(u.searchParams.get("ms") || 0);
    openUntil = ms < 0 ? -1 : Date.now() + ms;
    res.end("ok\n");
    return;
  }
  if (path === "/tarball.tgz") {
    if (openUntil === -1 || Date.now() < openUntil) return notFound(res);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": tgz.length });
    res.end(tgz);
    return;
  }
  if (path === "/" + pkg) {
    const base = `http://127.0.0.1:${port}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      name: pkg,
      "dist-tags": { preview: ver, latest: ver },
      versions: {
        [ver]: { name: pkg, version: ver, bin: { anet: "bin/anet.js" }, dist: { tarball: `${base}/tarball.tgz`, integrity, shasum } },
      },
    }));
    return;
  }
  notFound(res);
}).listen(port, "127.0.0.1", () => console.log(`fake registry on ${port}`));
