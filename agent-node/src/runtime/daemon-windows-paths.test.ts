import { expect, test } from "bun:test";
import { appendExtraPath, computeChildPath, minimalEnv } from "./create-node-daemon.js";
import { daemonCliLaunch } from "./daemon-cli-launch.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("App HOME overrides OS profile for every child home variable", () => {
  const env = minimalEnv({}, "win32", {
    HOME: 'D:\\ANet Private\\home', USERPROFILE: 'C:\\Users\\cloud',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\cloud',
  });
  expect(env.HOME).toBe('D:\\ANet Private\\home');
  expect(env.USERPROFILE).toBe(env.HOME);
  expect(env.HOMEDRIVE).toBe('D:');
  expect(env.HOMEPATH).toBe('\\ANet Private\\home');
});
test("Windows fixed PATH preserves drive letters and uses semicolon extras", () => {
  const base = computeChildPath("win32", 'C:\\Private Node\\node.exe');
  expect(base).toBe('C:\\Private Node');
  expect(appendExtraPath(base, ['D:\\tools', 'C:\\Private Node'], "win32")).toBe('C:\\Private Node;D:\\tools');
});
test("Windows lifecycle tools use trusted SystemRoot rather than user PATH", () => {
  expect(computeChildPath("win32", 'D:\\Private Node\\node.exe', 'C:\\Windows')).toBe('D:\\Private Node;C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  const env = minimalEnv({}, "win32", { HOME: 'D:\\Private', SystemRoot: 'C:\\Windows', TEMP: 'D:\\Private\\temp', PATH: 'C:\\attacker' });
  expect(env.SystemRoot).toBe('C:\\Windows');
  expect(env.TEMP).toBe('D:\\Private\\temp');
  expect(env.PATH).not.toContain('attacker');
  expect(() => minimalEnv({ SystemRoot: 'C:\\attacker' }, "win32", { HOME: 'D:\\Private' })).toThrow();
});
test("UNC private home does not inherit the cloud account's home drive", () => {
  const env = minimalEnv({}, "win32", { HOME: '\\\\server\\share\\app', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\cloud' });
  expect(env.HOMEDRIVE).toBe('\\\\server\\share');
  expect(env.HOMEPATH).toBe('\\app');
});
test("POSIX fixed PATH still uses colons", () => {
  expect(computeChildPath("linux", "/custom/node")).toStartWith('/custom:');
  expect(appendExtraPath('/bin:/usr/bin', ['/extra'], "linux")).toBe('/bin:/usr/bin:/extra');
});

test.skipIf(process.platform !== "win32")("native Windows JS child resolves only the App private config", () => {
  const root = mkdtempSync(join(tmpdir(), "anet private & paths "));
  try {
    const privateHome = join(root, "app home"), cloudHome = join(root, "cloud home");
    for (const home of [privateHome, cloudHome]) mkdirSync(join(home, ".anet"), { recursive: true });
    const cloudConfig = join(cloudHome, ".anet", "config.json");
    writeFileSync(cloudConfig, 'CLOUD-SENTINEL-DO-NOT-PARSE');
    writeFileSync(join(privateHome, ".anet", "config.json"), '{"workspace":"private"}');
    const entry = join(root, "anet private & child.cjs");
    writeFileSync(entry, `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const f=p.join(os.homedir(),'.anet','config.json');const c=JSON.parse(fs.readFileSync(f,'utf8'));fs.writeFileSync(f,JSON.stringify({...c,child:true}));console.log(os.homedir());`);
    const env = minimalEnv({}, "win32", { ...process.env, HOME: privateHome, USERPROFILE: cloudHome });
    const plan = daemonCliLaunch(entry, []);
    expect(execFileSync(plan.command, plan.args, { env, encoding: "utf8", timeout: 10_000 }).trim()).toBe(privateHome);
    expect(readFileSync(cloudConfig, "utf8")).toBe('CLOUD-SENTINEL-DO-NOT-PARSE');
    expect(JSON.parse(readFileSync(join(privateHome, ".anet", "config.json"), "utf8"))).toEqual({ workspace: "private", child: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
