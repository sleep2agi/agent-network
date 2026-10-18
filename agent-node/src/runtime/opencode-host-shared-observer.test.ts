// #1313 negative controls + the scope boundary.
//
// The provider reports PROCESS EVIDENCE. It must never turn an argv shape into a
// proven generation (通信牛, 2026-10-16): `argvContract` is a diagnostic, and a
// consumer that needs a generation binds it itself (#1302) and refuses reuse
// when it cannot prove it. So this file asserts two things side by side:
//   A. deterministic reason coverage with injected deps (no /proc needed);
//   B. REAL listening processes observed through the real /proc — no mocks for
//      the positive case, because "the pid we found is the pid we bound through"
//      is the very property under test.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeHostSharedAliveProbe,
  observeHostSharedServe,
  parseLoopbackUrl,
  type HostSharedObserverDeps,
} from "./opencode-host-shared-observer.js";

const V1_ARGS = ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--pure"];
const V2_ARGS = ["serve", "--hostname", "127.0.0.1", "--port", "4096"];
const URL_4096 = "http://127.0.0.1:4096";

/** Scripted /proc: one LISTEN inode, one owner pid, given argv/uid/ticks. */
function fakeProc(opts: {
  inode?: string;
  pid?: number;
  uid?: number | undefined;
  ticks?: string | string[];
  argv?: string[];
  platform?: NodeJS.Platform;
  fdsThrow?: NodeJS.ErrnoException;
  tcpThrow?: NodeJS.ErrnoException;
}): HostSharedObserverDeps {
  const inode = opts.inode ?? "4242";
  const pid = opts.pid ?? 777;
  const uid = "uid" in opts ? opts.uid : 1000;
  const ticks = opts.ticks ?? "900";
  let tickCall = 0;
  return {
    platform: opts.platform ?? "linux",
    readProcFile: (path) => {
      if (path === "/proc/net/tcp") {
        if (opts.tcpThrow) throw opts.tcpThrow;
        return [
          "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
          `  0: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 ${inode} 1 0 0 0 0`,
        ].join("\n");
      }
      if (path.endsWith("/cmdline")) return (opts.argv ?? ["/opt/opencode", ...V2_ARGS]).join("\0") + "\0";
      return "";
    },
    readDir: (path) => {
      if (path === "/proc") return ["1", String(pid), "self"];
      if (opts.fdsThrow) throw opts.fdsThrow;
      return ["0", "1", "7"];
    },
    readLink: (path) => {
      if (path.endsWith("/exe")) return "/opt/opencode";
      return path.includes(`/proc/${pid}/fd/7`) ? `socket:[${inode}]` : "/dev/null";
    },
    procUid: () => uid,
    liveProcess: (requested) => {
      if (requested !== pid) return undefined;
      const value = Array.isArray(ticks) ? ticks[Math.min(tickCall++, ticks.length - 1)] : ticks;
      return { pid, ticks: value, state: "S" };
    },
    serveArgsFor: (generation, host, port) =>
      generation === "v1"
        ? ["serve", "--hostname", host, "--port", String(port), "--pure"]
        : ["serve", "--hostname", host, "--port", String(port)],
  };
}

describe("process evidence (injected /proc)", () => {
  test("a live same-uid listener yields pid/uid/startTicks/inode from one chain", () => {
    const r = observeHostSharedServe(URL_4096, fakeProc({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.processEvidence).toMatchObject({
      url: URL_4096, host: "127.0.0.1", port: 4096,
      listenInode: "4242", pid: 777, uid: 1000, startTicks: 900,
    });
  });

  test("the provider NEVER claims a proven generation — argv is diagnostics only", () => {
    const r = observeHostSharedServe(URL_4096, fakeProc({ argv: ["/opt/opencode", ...V1_ARGS] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No generation assertion anywhere on the evidence object.
    expect(Object.keys(r.processEvidence)).not.toContain("generation");
    expect(JSON.stringify(r.processEvidence)).not.toMatch(/"generation"\s*:/);
    // The shape is reported, and it says what it is (and is not).
    expect(r.processEvidence.diagnostics.argvContract).toBe("v1");
    expect(r.processEvidence.diagnostics.argvContractNote).toMatch(/not prove|diagnostic/i);
    expect(r.processEvidence.diagnostics.argvTail).toEqual(V1_ARGS);
  });

  test("argv shape is classified but a mismatch is still evidence, not a failure", () => {
    for (const [argv, expected] of [
      [["/opt/opencode", ...V2_ARGS], "v2"],
      [["/opt/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096", "--mystery"], "none"],
      [["/opt/opencode"], "none"],
      [["/opt/other-binary", ...V2_ARGS], "none"],
      [["/opt/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4097"], "none"],
    ] as const) {
      const r = observeHostSharedServe(URL_4096, fakeProc({ argv: [...argv] }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.processEvidence.diagnostics.argvContract).toBe(expected);
    }
  });

  test("the executable is labelled: /proc/<pid>/exe, or a mutable argv[0] fallback", () => {
    const read = observeHostSharedServe(URL_4096, fakeProc({}));
    expect(read.ok && read.processEvidence.diagnostics.executable).toBe("/opt/opencode");
    expect(read.ok && read.processEvidence.diagnostics.executableSource).toBe("proc_exe");

    // exe unreadable → argv[0] is used but LABELLED, so binding cannot mistake it
    // for the observed binary (通信牛, #2784 review).
    const fallback = fakeProc({});
    fallback.readLink = (path) => {
      if (path.endsWith("/exe")) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return path.includes("/proc/777/fd/") ? "socket:[4242]" : "/dev/null";
    };
    const r = observeHostSharedServe(URL_4096, fallback);
    expect(r.ok && r.processEvidence.diagnostics.executable).toBe("/opt/opencode");
    expect(r.ok && r.processEvidence.diagnostics.executableSource).toBe("argv0");

    // Neither readable → no executable at all, never a fabricated one.
    const none = fakeProc({});
    none.readLink = (path) => {
      if (path.endsWith("/exe")) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return path.includes("/proc/777/fd/") ? "socket:[4242]" : "/dev/null";
    };
    none.readProcFile = (path) => {
      if (path === "/proc/net/tcp") {
        return [
          "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
          "  0: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 4242 1 0 0 0 0",
        ].join("\n");
      }
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    const r2 = observeHostSharedServe(URL_4096, none);
    expect(r2.ok && r2.processEvidence.diagnostics.executable).toBeNull();
    expect(r2.ok && r2.processEvidence.diagnostics.executableSource).toBeNull();
    // An unreadable cmdline is still an observation: the process identity stands.
    expect(r2.ok && r2.processEvidence.diagnostics.argvContract).toBe("none");
    expect(r2.ok && r2.processEvidence.pid).toBe(777);
  });


  test("non-Linux is explicitly unobservable", () => {
    expect(observeHostSharedServe(URL_4096, fakeProc({ platform: "darwin" })))
      .toEqual({ ok: false, reason: "unsupported_platform" });
  });

  test("only the literal 127.0.0.1 form is observable — raw string, not a normalized URL", () => {
    // Every one of these normalizes to 127.0.0.1 under `new URL()`; the provider
    // must still refuse them (#2784 review).
    const refused = [
      "http://localhost:4096",
      "http://[::1]:4096",
      "http://10.0.0.5:4096",
      "https://127.0.0.1:4096",
      "http://a:b@127.0.0.1:4096",
      "http://127.1:4096",
      "http://2130706433:4096",
      "http://0x7f000001:4096",
      "http://127.0.0.1:4096/",
      "http://127.0.0.1:4096/path",
      "http://127.0.0.1:4096?x=1",
      "http://127.0.0.1:4096#frag",
      "http://127.0.0.1:04096",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1",
      "HTTP://127.0.0.1:4096",
      "http://127.0.0.1:4096 ",
      "http://127.0.0.01:4096",
      "nope",
    ];
    for (const url of refused) {
      expect(parseLoopbackUrl(url)).toBeUndefined();
      expect(observeHostSharedServe(url, fakeProc({}))).toEqual({ ok: false, reason: "url_not_supported" });
    }
    expect(parseLoopbackUrl(URL_4096)).toEqual({ port: 4096 });
    expect(parseLoopbackUrl("http://127.0.0.1:65535")).toEqual({ port: 65535 });
  });

  test("a denial inside the candidate set is a refusal even when an owner was found (#2784 review)", () => {
    // Mixed permissions: pid 777 is readable and holds the socket, pid 888 is a
    // same-uid candidate whose fd table we cannot read. Uniqueness is therefore
    // unprovable, so the visible owner must NOT be reported — while the very same
    // tree without the unreadable candidate IS observable (the denial is what
    // changes the answer, not something else).
    const withDenied = fakeProc({});
    withDenied.readDir = (path) => {
      if (path === "/proc") return ["1", "777", "888", "self"];
      if (path === "/proc/888/fd") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return ["0", "1", "7"];
    };
    expect(observeHostSharedServe(URL_4096, withDenied)).toEqual({ ok: false, reason: "permission_denied" });

    const withoutDenied = fakeProc({});
    withoutDenied.readDir = (path) => (path === "/proc" ? ["1", "777", "self"] : ["0", "1", "7"]);
    const ok = observeHostSharedServe(URL_4096, withoutDenied);
    expect(ok.ok).toBe(true);
  });

  test("an inherited fd is found even when the holder uid differs from the socket uid (#2784 review)", () => {
    // 通信牛's counterexample: a uid-65534 child inherits a listening fd whose
    // socket uid is 0. Filtering candidates by the socket uid would MISS the real
    // holder and wrongly report socket_owner_not_found.
    const deps = fakeProc({});
    deps.procUid = () => 65534; // the holder is nobody...
    deps.readDir = (path) => (path === "/proc" ? ["1", "777", "self"] : ["0", "1", "7"]);
    const r = observeHostSharedServe(URL_4096, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.processEvidence.uid).toBe(65534);                 // real holder, not the socket's 1000
    expect(r.processEvidence.pid).toBe(777);
    expect(r.processEvidence.diagnostics.socketUid).toBe(1000); // reported, never used to filter
  });

  test("two LISTEN sockets on the port are `ambiguous_listener`", () => {
    const deps = fakeProc({});
    deps.readProcFile = (path) => {
      if (path === "/proc/net/tcp") {
        return [
          "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
          "  0: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 4242 1 0 0 0 0",
          "  1: 0100007F:1000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000 0 4343 1 0 0 0 0",
        ].join("\n");
      }
      return "";
    };
    expect(observeHostSharedServe(URL_4096, deps)).toEqual({ ok: false, reason: "ambiguous_listener" });
  });

  test("a missing listener is `no_listener`, not a guess", () => {
    const deps = fakeProc({});
    deps.readProcFile = (path) => (path === "/proc/net/tcp"
      ? "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"
      : "");
    expect(observeHostSharedServe(URL_4096, deps)).toEqual({ ok: false, reason: "no_listener" });
  });

  test("an inode held by nobody is `socket_owner_not_found`", () => {
    const deps = fakeProc({});
    deps.readLink = () => "/dev/null";
    expect(observeHostSharedServe(URL_4096, deps)).toEqual({ ok: false, reason: "socket_owner_not_found" });
  });

  test("permission errors are reported, not swallowed into a wrong answer", () => {
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" }) as NodeJS.ErrnoException;
    expect(observeHostSharedServe(URL_4096, fakeProc({ tcpThrow: eacces }))).toEqual({ ok: false, reason: "permission_denied" });
    expect(observeHostSharedServe(URL_4096, fakeProc({ fdsThrow: eacces }))).toEqual({ ok: false, reason: "permission_denied" });
  });

  test("start ticks changing between the two reads is `identity_mismatch` (PID reuse)", () => {
    expect(observeHostSharedServe(URL_4096, fakeProc({ ticks: ["900", "901"] })))
      .toEqual({ ok: false, reason: "identity_mismatch" });
  });

  test("a process that died between the reads is `identity_mismatch`, not a stale success", () => {
    const deps = fakeProc({});
    let calls = 0;
    deps.liveProcess = (pid) => (calls++ === 0 ? { pid, ticks: "900", state: "S" } : undefined);
    expect(observeHostSharedServe(URL_4096, deps)).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  test("an unobservable uid is never fabricated", () => {
    // The holder is found, but its uid cannot be read: refuse rather than invent one.
    const deps = fakeProc({});
    deps.procUid = () => undefined;
    expect(observeHostSharedServe(URL_4096, deps)).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  test("a provider failure is a reason, never a throw", () => {
    const deps = fakeProc({});
    deps.readProcFile = () => { throw new Error("boom"); };
    expect(observeHostSharedServe(URL_4096, deps).ok).toBe(false);
  });

  test("PID 1 is a candidate: skipping it would report a wrong unique holder (#2784 review)", () => {
    // PID 1 alone holds the socket: it must be FOUND (not skipped as a non-process).
    const sole = fakeProc({ pid: 1 });
    sole.readDir = (path) => (path === "/proc" ? ["1", "self"] : ["0", "1", "7"]);
    sole.liveProcess = () => ({ pid: 1, ticks: "900", state: "S" });
    sole.readLink = (path) => (path.endsWith("/exe") ? "/opt/opencode" : (path.includes("/proc/1/fd/") ? "socket:[4242]" : "/dev/null"));
    const r = observeHostSharedServe(URL_4096, sole);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.processEvidence.pid).toBe(1);

    // PID 1 AND another process hold it => two holders => ambiguous, never a
    // single-holder claim.
    const both = fakeProc({ pid: 777 });
    both.readDir = (path) => (path === "/proc" ? ["1", "777", "self"] : ["0", "1", "7"]);
    both.readLink = (path) => (path.endsWith("/exe") ? "/opt/opencode" : "socket:[4242]");
    both.procUid = () => 1000;
    both.liveProcess = (pid) => ({ pid, ticks: "900", state: "S" });
    expect(observeHostSharedServe(URL_4096, both)).toEqual({ ok: false, reason: "ambiguous_listener" });
  });

  test("probeAlive keeps its PID 1 refusal (the holder scan is what must include it)", () => {
    const deps = fakeProc({ pid: 1 });
    deps.liveProcess = (pid) => (pid === 1 ? { pid: 1, ticks: "900", state: "S" } : undefined);
    const probe = makeHostSharedAliveProbe(deps);
    expect(probe(1, 900)).toBe(false); // unchanged policy: admission for PID 1 is separate
    expect(probe(0, 900)).toBe(false);
    expect(probe(777, 900)).toBe(false);
  });

  test("probeAlive re-checks ticks, so PID reuse cannot pass", () => {
    const probe = makeHostSharedAliveProbe(fakeProc({ ticks: "900" }));
    expect(probe(777, 900)).toBe(true);
    expect(probe(777, 901)).toBe(false);
    expect(probe(778, 900)).toBe(false);
    expect(probe(1, 900)).toBe(false);
    expect(probe(777, Number.NaN)).toBe(false);
  });
});

// ── B. real processes ────────────────────────────────────────────────────────
const FAKE_OPENCODE = `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const i = argv.indexOf("--port");
const port = Number(argv[i + 1]);
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
await new Promise(() => {});
`;

interface Spawned {
  pid: number;
  port: number;
  dir: string;
  proc: ReturnType<typeof Bun.spawn>;
}

const spawned: Spawned[] = [];

async function startFakeServe(extraArgs: string[] = []): Promise<Spawned> {
  const dir = mkdtempSync(join(tmpdir(), "obs1313-"));
  const bin = join(dir, "opencode");
  writeFileSync(bin, FAKE_OPENCODE, { mode: 0o755 });
  chmodSync(bin, 0o755);
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", String(port), ...extraArgs], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const result = { pid: proc.pid, port, dir, proc };
    spawned.push(result);
    if (await waitForListener(port)) return result;
    proc.kill();
  }
  throw new Error("could not start a real loopback listener");
}

/** Wait until the port has a listener. A full success is NOT required: the
 *  diagnostics cases legitimately report `argvContract: "none"` and still have a
 *  real listening process. */
async function waitForListener(port: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const r = observeHostSharedServe(`http://127.0.0.1:${port}`);
    if (r.ok || (r.reason !== "no_listener" && r.reason !== "socket_owner_not_found")) return true;
    await Bun.sleep(20);
  }
  return false;
}

/** Real-process positives run against the REAL /proc of whatever machine runs
 *  them. On a busy multi-user host an unprivileged reader may genuinely be unable
 *  to read every same-uid process's fds, and the provider then refuses
 *  (`permission_denied`) because uniqueness cannot be proven — that is the
 *  behaviour under test, not a wrong answer. The strict positive is therefore
 *  asserted in the isolated Docker suite (a single-uid process table); here we
 *  assert "observed, or refused for a stated reason — never a wrong answer". */
function expectObservedOrEnvRefusal(
  r: ReturnType<typeof observeHostSharedServe>,
): Extract<ReturnType<typeof observeHostSharedServe>, { ok: true }> | null {
  if (r.ok) return r;
  if (r.reason !== "permission_denied") throw new Error(`unexpected reason: ${r.reason}`);
  return null;
}

afterEach(() => {
  for (const s of spawned.splice(0)) {
    try { s.proc.kill(); } catch { /* already gone */ }
    try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe.if(process.platform === "linux")("observer against real listening processes", () => {
  test("a real listener is observed: pid, uid, startTicks and inode all come from /proc", async () => {
    const s = await startFakeServe();
    const ev = expectObservedOrEnvRefusal(observeHostSharedServe(`http://127.0.0.1:${s.port}`));
    if (!ev) return; // environment could not prove uniqueness; refusal already asserted
    expect(ev.processEvidence.pid).toBe(s.pid);
    expect(ev.processEvidence.uid).toBe(process.getuid?.());
    expect(Number.isFinite(ev.processEvidence.startTicks)).toBe(true);
    expect(ev.processEvidence.listenInode).toMatch(/^\d+$/);
    expect(ev.processEvidence.diagnostics.argvContract).toBe("v2");
    expect(makeHostSharedAliveProbe()(ev.processEvidence.pid, ev.processEvidence.startTicks)).toBe(true);
  });

  test("a V1-shaped invocation is classified v1 — as a diagnostic, not a generation", async () => {
    const s = await startFakeServe(["--pure"]);
    const ev = expectObservedOrEnvRefusal(observeHostSharedServe(`http://127.0.0.1:${s.port}`));
    if (!ev) return;
    expect(ev.processEvidence.diagnostics.argvContract).toBe("v1");
    expect(Object.keys(ev.processEvidence)).not.toContain("generation");
  });

  test("an unknown flag is still observable, with contract `none`", async () => {
    const s = await startFakeServe(["--mystery"]);
    const ev = expectObservedOrEnvRefusal(observeHostSharedServe(`http://127.0.0.1:${s.port}`));
    if (!ev) return;
    expect(ev.processEvidence.diagnostics.argvContract).toBe("none");
  });

  test("a killed listener is `no_listener` — no stale success", async () => {
    const s = await startFakeServe();
    s.proc.kill();
    await Bun.sleep(150);
    const after = observeHostSharedServe(`http://127.0.0.1:${s.port}`);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(["no_listener", "socket_owner_not_found", "permission_denied"]).toContain(after.reason);
  });
});
