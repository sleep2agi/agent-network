import { describe, expect, test } from "bun:test";
import {
  assertCopresenceSupported,
  chmodIfPosix,
  modeIsExactly,
  modeIsOwnerOnly,
  posixFileModes,
  copresenceCapabilities,
  copresenceDowngradeNotice,
  copresenceEndpointIsFilesystemPath,
  copresenceIpcEndpoint,
} from "./platform";

describe("grok copresence platform capabilities", () => {
  test("linux keeps every guarantee and the existing Unix socket path verbatim", () => {
    const caps = copresenceCapabilities("linux");
    expect(caps.supported).toBe(true);
    expect(caps.ipc).toBe("unix-socket");
    expect(caps.kernelSandbox).toBe(true);
    expect(caps.reducedGuarantees).toEqual([]);
    // 🔴 Linux 上端点必须【逐字】等于原来的路径 —— 这条防的是「顺手把所有平台
    //    都改成管道」这种回归：那会让既有 Linux 部署的 socket 路径全变。
    expect(copresenceIpcEndpoint("/run/x/leader.sock", caps)).toBe("/run/x/leader.sock");
    expect(copresenceEndpointIsFilesystemPath(caps)).toBe(true);
    expect(copresenceDowngradeNotice(caps)).toEqual([]);
    expect(caps.homeIsolationHidesVendorSkills).toBe(true);
  });

  test("linux without /proc is refused, and the error names what is missing", () => {
    const caps = copresenceCapabilities("linux", { hasProcSelfFd: false });
    expect(caps.supported).toBe(false);
    expect(caps.missingHard).toEqual(["/proc/self/fd"]);
    expect(() => assertCopresenceSupported(caps)).toThrow("/proc/self/fd");
  });

  test("windows is supported over a named pipe, and says exactly what it loses", () => {
    const caps = copresenceCapabilities("win32");
    expect(caps.supported).toBe(true);
    expect(caps.ipc).toBe("named-pipe");
    // 实测：AF_UNIX 在 Windows 上 EACCES，命名管道 ok。
    expect(copresenceEndpointIsFilesystemPath(caps)).toBe(false);
    expect(caps.kernelSandbox).toBe(false);
    expect(caps.procfs).toBe(false);
    expect(caps.posixFileModes).toBe(false);
    expect(caps.missingHard).toEqual([]);
    expect(caps.reducedGuarantees.length).toBe(4);
    expect(caps.homeIsolationHidesVendorSkills).toBe(false);
    const notice = copresenceDowngradeNotice(caps);
    // 🔴 降级必须是【逐条】打出来的，不能只说一句"较弱" ——
    //    用户要能判断"我这个任务能不能接受丢这三样"。
    expect(notice.length).toBe(1 + 4 + 1);
    expect(notice.join("\n")).toContain("没有内核层强制");
    expect(notice.join("\n")).toContain("Landlock/Seatbelt");
    expect(notice.join("\n")).toContain("unshare");
    // 仍然生效的那半也必须写出来，否则读者会以为什么都没了。
    expect(notice.join("\n")).toContain("--agent profile + --deny");
    // 🔴 "隔离 HOME 挡不住厂商技能"这条必须出现在横幅里 —— 它是实测出来的，
    //    而且是操作者唯一能看到"我接受了什么"的地方。
    expect(notice.join("\n")).toContain(".agents/.claude");
  });

  test("named pipe names are namespaced by the full path, not by the basename", () => {
    const caps = copresenceCapabilities("win32");
    const a = copresenceIpcEndpoint("C:\\Users\\u\\.anet-grok\\node-a\\run\\leader.sock", caps);
    const b = copresenceIpcEndpoint("C:\\Users\\u\\.anet-grok\\node-b\\run\\leader.sock", caps);
    // 🔴 管道命名空间是【全机器全局】的：两个节点的 leader.sock 同名，
    //    若按 basename 命名就会互相抢。这条钉住"按完整路径哈希"。
    expect(a).not.toBe(b);
    for (const name of [a, b]) {
      expect(name.startsWith("\\\\.\\pipe\\anet-grok-")).toBe(true);
      expect(name).toMatch(/^\\\\\.\\pipe\\anet-grok-[0-9a-f]{32}$/);
    }
    // 同一路径必须稳定（恢复代要能重连同一个管道）
    expect(copresenceIpcEndpoint("C:\\x\\leader.sock", caps))
      .toBe(copresenceIpcEndpoint("C:\\x\\leader.sock", caps));
  });

  test("an unverified platform is refused rather than silently downgraded", () => {
    const caps = copresenceCapabilities("darwin");
    expect(caps.supported).toBe(false);
    expect(() => assertCopresenceSupported(caps)).toThrow("darwin");
    // fail-closed 的方向：没验过的平台走"拒绝"，不是走"当成 Windows 那套降级跑"。
    expect(caps.reducedGuarantees).toEqual([]);
  });
});

describe("POSIX file-mode predicates", () => {
  test("mode assertions still判事 on POSIX and go silent only where modes do not exist", () => {
    expect(posixFileModes("linux")).toBe(true);
    expect(posixFileModes("darwin")).toBe(true);
    expect(posixFileModes("win32")).toBe(false);
    // 🔴 这一格是被变异测试逼出来的：把 posixFileModes 改成恒真时，
    //    原来的测试全绿 —— 说明没有任何断言在看它。
    // Linux：0o600 必须【恰好】相等，0o644 要红。
    expect(modeIsExactly(0o100600, 0o600)).toBe(true);
    expect(modeIsExactly(0o100644, 0o600)).toBe(false);
    expect(modeIsOwnerOnly(0o40700)).toBe(true);
    expect(modeIsOwnerOnly(0o40750)).toBe(false);
  });

  test("chmod is a no-op exactly where mode bits do not exist, and runs everywhere else", () => {
    let ran = 0;
    chmodIfPosix(() => { ran += 1; }, "linux");
    expect(ran).toBe(1);
    chmodIfPosix(() => { ran += 1; }, "darwin");
    expect(ran).toBe(2);
    // Windows 上 fchmod 会 EPERM（实测 `Refusing unsafe global config: EPERM ... fchmod`）
    chmodIfPosix(() => { ran += 1; }, "win32");
    expect(ran).toBe(2);
  });
});
