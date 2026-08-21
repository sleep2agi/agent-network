/**
 * 共存运行时的**平台能力**。
 *
 * 🔴 这个模块存在的理由：原来是一句 `process.platform !== "linux"` 就整体拒绝。
 *    那句话把「不支持」和「少了哪几样、少了会失去什么」压成了一格 ——
 *    用户看到的只有「requires Linux」，既不知道差什么，也不知道换个平台会丢什么保证。
 *
 * 实测（2026-08-20，Windows 11 build 26200 + node v24.18.0 + grok 1.0.5）：
 *   · node-pty / ConPTY  ⇒ 可用（spawn cmd.exe 拿到了带 ANSI 的 PTY_OK）
 *   · 命名管道           ⇒ 可用
 *   · AF_UNIX            ⇒ EACCES（同一进程里命名管道成功）⇒ Windows 必须走命名管道
 *   · /proc              ⇒ absent
 *   · 内核沙箱           ⇒ **grok 自己就不支持**：它的 Platform Support 表只有
 *                          Linux/Landlock 与 macOS/Seatbelt，没有 Windows
 */
import { createHash } from "crypto";

export type CopresenceIpc = "unix-socket" | "named-pipe";

export interface CopresenceCapabilities {
  readonly platform: NodeJS.Platform;
  /** 能不能跑共存。false 时 missingHard 说明缺什么。 */
  readonly supported: boolean;
  readonly ipc: CopresenceIpc;
  /** deny 列表是否由内核强制（Landlock/Seatbelt）。 */
  readonly kernelSandbox: boolean;
  /** /proc 是否可用（父 pid / fd 校验依赖它）。 */
  readonly procfs: boolean;
  /** POSIX 文件模式位（0700/0600）是否有意义。 */
  readonly posixFileModes: boolean;
  /** 硬缺口：非空即不支持。 */
  readonly missingHard: readonly string[];
  /**
   * 隔离 HOME 能不能真的挡住厂商技能/子代理的发现。
   *
   * 🔴 Linux：能 —— 改 HOME 后 `grok inspect --json` 的 skills 归零。
   * 🔴 Windows：**不能**。实测同一台机、同一个 grok 1.0.5，
   *    把 USERPROFILE / HOME / HOMEDRIVE / HOMEPATH / GROK_HOME 全部重定向之后：
   *      真实家目录 ⇒ skills=53，外部来源 53
   *      隔离家目录 ⇒ skills=31，外部来源 31（仍是 C:\Users\<u>\.agents\skills\...）
   *    也就是说 grok 在 Windows 上不按环境变量解析 `.agents`。
   *    ⇒ 这一格不能靠"把断言放松"糊过去：断言仍然拒绝一切可隔离的外部来源，
   *      只对【已证明隔离不了】的这一类改为**逐条列出并在启动时打印**。
   */
  readonly homeIsolationHidesVendorSkills: boolean;
  /** 软缺口：能跑，但**失去**这些保证。必须对用户明说。 */
  readonly reducedGuarantees: readonly string[];
}

export interface CopresenceCapabilityProbe {
  /** /proc/self/fd 是否存在。注入以便测试，不去碰真实文件系统。 */
  readonly hasProcSelfFd: boolean;
}

export function copresenceCapabilities(
  platform: NodeJS.Platform = process.platform,
  probe?: CopresenceCapabilityProbe,
): CopresenceCapabilities {
  if (platform === "linux") {
    // Linux 上 /proc 是硬前提：父 pid / fd 校验、以及 unshare 的 uid_map 都要它。
    const procfs = probe?.hasProcSelfFd ?? true;
    return {
      platform,
      supported: procfs,
      ipc: "unix-socket",
      kernelSandbox: true,
      procfs,
      posixFileModes: true,
      homeIsolationHidesVendorSkills: true,
      missingHard: procfs ? [] : ["/proc/self/fd"],
      reducedGuarantees: [],
    };
  }
  if (platform === "darwin") {
    // 实测于 2026-08-21,Apple M4 / macOS(Darwin 25.3.0) / grok 1.0.5:
    //
    //   /proc/self/fd            不存在
    //   AF_UNIX bind+listen      可用,lstat 认得 S_ISSOCK
    //   chmod 0600               生效(0o600)
    //   PTY (openpty)            可用,从属端 isatty=true
    //   隔离 HOME 挡厂商技能      挡不住:真实家目录 skills=122,隔离家目录 skills=89
    //                            —— 与 Windows 同一结论(53→31),非零即挡不住
    //
    // 🔴 关键的那一格:grok 在 macOS 上是 **leaderless**。同一台机跑 `grok`,
    //    TUI 正常起来(Grok 4.6 / Grok Build 1.0.5),而 ~/.grok/leader.sock 与
    //    leader.lock **都没有被创建**(Linux 上两者都在)。因此 leader-lifecycle.ts
    //    那条建立在 /proc/net/unix + /proc/<pid>/{exe,cmdline,environ} 上的
    //    身份链在这里根本不会被进入 —— 和 win32 走的是同一条 leaderless 路径。
    //
    //    这一格必须实测,不能推断:macOS 上**读不到另一个进程的 environ**
    //    (ps -E / ps eww 对自己刚启动的子进程也读不到),所以那条链如果真的
    //    会被进入,它是**无法忠实移植的**,而不是"换个 API 就行"。
    return {
      platform,
      supported: true,
      ipc: "unix-socket",
      kernelSandbox: false,
      procfs: false,
      posixFileModes: true,
      homeIsolationHidesVendorSkills: false,
      missingHard: [],
      // 🔴 与 win32 那份一样,这些是**真的丢了**,不是措辞问题。
      reducedGuarantees: [
        "内核强制的 deny 路径 —— grok inspect 在 macOS 上不报告任何沙箱后端"
        + "(系统有 /usr/bin/sandbox-exec,但没有证据表明 grok 使用它)",
        "每轮 unshare --user 的用户命名空间隔离(Linux 专用)",
        "基于 /proc 的父进程与 fd 校验 —— macOS 无 /proc,且**读不到别的进程的"
        + " environ**,所以这一格不是降级而是不可得",
        "隔离 HOME 对厂商技能无效:实测同机 grok 1.0.5,真实家目录 skills=122、"
        + "隔离家目录 skills=89,它们的【指令文本】仍会进入上下文",
      ],
    };
  }
  if (platform === "win32") {
    return {
      platform,
      supported: true,
      ipc: "named-pipe",
      kernelSandbox: false,
      procfs: false,
      posixFileModes: false,
      homeIsolationHidesVendorSkills: false,
      missingHard: [],
      // 🔴 这三条是**真的丢了**，不是措辞问题。写在这里是为了让启动横幅逐条打出来。
      reducedGuarantees: [
        "内核强制的 deny 路径（Landlock/Seatbelt）—— grok 在 Windows 上没有沙箱后端",
        "每轮 unshare --user 的用户命名空间隔离",
        "基于 /proc 的父进程与 fd 校验、POSIX 0700/0600 文件模式、以及 uid 属主核对",
        "隔离 HOME 对厂商技能无效：grok 仍会读取真实用户目录下的 .agents/.claude 技能"
        + "（实测重定向全部家目录变量后依旧读到），它们的【指令文本】会进入上下文",
      ],
    };
  }
  return {
    platform,
    supported: false,
    ipc: "unix-socket",
    kernelSandbox: false,
    procfs: false,
    posixFileModes: false,
    homeIsolationHidesVendorSkills: false,
    missingHard: [`平台 ${platform} 尚未验证过共存所需的 PTY / IPC / 隔离原语`],
    reducedGuarantees: [],
  };
}

export function assertCopresenceSupported(caps: CopresenceCapabilities): void {
  if (caps.supported) return;
  throw new Error(
    `grok co-presence 无法在 ${caps.platform} 上运行，缺少：${caps.missingHard.join("；")}`,
  );
}

/**
 * IPC 端点路径。
 *
 * Linux 仍是原来的 Unix socket 文件路径（保持既有行为逐字不变）；
 * Windows 返回命名管道名 —— 🔴 管道名不是文件系统路径，
 * 所以调用方不能对它做 lstat / mode / realpath 那套校验。
 */
export function copresenceIpcEndpoint(
  unixPath: string,
  caps: CopresenceCapabilities,
): string {
  if (caps.ipc === "unix-socket") return unixPath;
  // 用完整路径的哈希做管道名：管道命名空间是全局的，必须避免不同节点/不同 home 撞名。
  const digest = createHash("sha256").update(unixPath).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\anet-grok-${digest}`;
}

/** 端点是不是文件系统路径（决定要不要做 lstat/mode/owner 那组校验）。 */
export function copresenceEndpointIsFilesystemPath(caps: CopresenceCapabilities): boolean {
  return caps.ipc === "unix-socket";
}

/** 启动横幅要逐条打出来的降级说明；无降级时返回空数组。 */
export function copresenceDowngradeNotice(caps: CopresenceCapabilities): readonly string[] {
  if (!caps.reducedGuarantees.length) return [];
  return [
    `🔴 ${caps.platform} 上的 grok 共存【没有内核层强制】。仍然生效的是 grok 自己的`
    + `固定工具清单（--agent profile + --deny），失去的是：`,
    ...caps.reducedGuarantees.map((line) => `   · ${line}`),
    "   ⇒ 只在受信任的任务与受信任的网络里使用。",
  ];
}

/** 这个平台上 POSIX 模式位有没有意义（NTFS 走 ACL，没有 mode 位）。 */
export function posixFileModes(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * 「模式位必须【恰好】是 expected」。
 *
 * 🔴 无模式位的平台上这一条恒真 —— 而这**正是**要写成函数的理由：
 *    散落在各处的 `(stat.mode & 0o777) !== 0o600` 如果各自加 `platform !== "win32"`，
 *    迟早漏一处；而漏掉的那处在 Windows 上会把合法文件误拒。
 *    同样重要的是：跳过的**只有模式位**，symlink / nlink / uid / dev+ino
 *    那些检查一条都不放过。
 */
export function modeIsExactly(mode: number, expected: number): boolean {
  return !posixFileModes() || (mode & 0o777) === expected;
}

/** 「除属主外无任何权限位」。无模式位的平台恒真，理由同上。 */
export function modeIsOwnerOnly(mode: number): boolean {
  return !posixFileModes() || (mode & 0o077) === 0;
}

/**
 * chmod / fchmod 包装：无模式位的平台上是 no-op。
 *
 * 🔴 Windows 上 `fchmod` 直接 EPERM（实测：
 *    `Refusing unsafe global config: EPERM: operation not permitted, fchmod`），
 *    而这些调用点的目的是"收紧"权限 —— 在一个没有权限位的文件系统上，
 *    收紧无从谈起。跳过它不会放宽任何东西；不跳过则整条路径直接崩。
 */
export function chmodIfPosix(
  apply: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  if (posixFileModes(platform)) apply();
}
