#!/usr/bin/env node
/**
 * Disposable npm registry for the unpublished candidate only.
 *
 * The candidate packument/tarball is served locally; dependency requests are
 * proxied to the public npm registry. This exercises the documented npx
 * preview path without publishing the candidate anywhere.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

const [tarball, portRaw = "4873"] = process.argv.slice(2);
if (!tarball) throw new Error("usage: local-registry.mjs <agent-node.tgz> [port]");
const port = Number(portRaw);
const archive = readFileSync(tarball);
const pkg = await new Promise((resolve, reject) => {
  const child = spawn("tar", ["-xOf", tarball, "package/package.json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code !== 0) reject(new Error("cannot read candidate package.json: " + stderr));
    else {
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    }
  });
});
const integrity = "sha512-" + createHash("sha512").update(archive).digest("base64");
const shasum = createHash("sha1").update(archive).digest("hex");
const sha256 = createHash("sha256").update(archive).digest("hex");
const base = "http://127.0.0.1:" + port;
const packument = JSON.stringify({
  name: pkg.name,
  "dist-tags": { preview: pkg.version },
  versions: {
    [pkg.version]: {
      ...pkg,
      dist: {
        tarball: base + "/candidate-agent-node.tgz",
        integrity,
        shasum,
      },
    },
  },
});

function proxy(req, res) {
  const upstream = https.request({
    protocol: "https:",
    hostname: "registry.npmjs.org",
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: "registry.npmjs.org" },
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream registry unavailable", detail: error.message }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && (
    path === "/@sleep2agi%2fagent-node"
    || path === "/@sleep2agi%2Fagent-node"
    || path === "/@sleep2agi/agent-node"
    || path === "/%40sleep2agi%2fagent-node"
    || path === "/%40sleep2agi%2Fagent-node"
  )) {
    process.stdout.write(`CANDIDATE_PACKUMENT version=${pkg.version}\n`);
    res.writeHead(200, {
      "content-type": "application/vnd.npm.install-v1+json",
      "content-length": Buffer.byteLength(packument),
    });
    res.end(packument);
    return;
  }
  if (req.method === "GET" && path === "/candidate-agent-node.tgz") {
    process.stdout.write(`CANDIDATE_TARBALL sha256=${sha256}\n`);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": statSync(tarball).size,
    });
    createReadStream(tarball).pipe(res);
    return;
  }
  proxy(req, res);
});

server.listen(port, "127.0.0.1", () => process.stdout.write("READY\n"));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
