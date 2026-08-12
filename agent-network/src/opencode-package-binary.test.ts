import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  discoverOpencodeForbiddenRoots,
  resolveOpencodePackageBinaryFromPath,
  validateOpencodePackageBinary,
} from "./opencode-package-binary";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function safeTestBase(): string {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode package identity tests require Linux uid semantics");
  }
  const userRoot = `/run/user/${process.getuid()}`;
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  chmodSync(userRoot, 0o700);
  const base = mkdtempSync(join(userRoot, "anet-opencode-package-test-"));
  cleanup.push(base);
  return base;
}

function makePackage(parent: string, overrides: Record<string, unknown> = {}): {
  root: string;
  binary: string;
  packageJson: string;
} {
  const root = join(parent, "node_modules", "opencode-ai");
  const bin = join(root, "bin");
  const binary = join(bin, "opencode.exe");
  const packageJson = join(root, "package.json");
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' 1.18.1\n", { mode: 0o755 });
  writeFileSync(packageJson, JSON.stringify({
    name: "opencode-ai",
    version: "1.18.1",
    // The 1.18.1 tarball spells this with `./`; registry metadata may display
    // the normalized form. The verifier accepts only these equivalent bytes.
    bin: { opencode: "./bin/opencode.exe" },
    ...overrides,
  }), { mode: 0o644 });
  return { root, binary, packageJson };
}

describe("validateOpencodePackageBinary", () => {
  test("accepts only the canonical exact npm package entrypoint", () => {
    const base = safeTestBase();
    const fixture = makePackage(base);
    expect(validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toBe(fixture.binary);
  });

  test("rejects a same-version package impersonator inside the project", () => {
    const project = join(safeTestBase(), "project");
    mkdirSync(project, { mode: 0o700 });
    const fixture = makePackage(project);
    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
      forbiddenRoots: [project],
    })).toThrow("project/node-local");
  });

  test("skips a same-version project shim and selects a later trusted package", () => {
    const base = safeTestBase();
    const project = join(base, "project");
    const localBin = join(project, "node_modules", ".bin");
    mkdirSync(localBin, { recursive: true, mode: 0o700 });
    const local = makePackage(join(project, "local-payload"));
    symlinkSync(local.binary, join(localBin, "opencode"));

    const global = makePackage(join(base, "global"));
    const globalBin = join(base, "global", "bin");
    mkdirSync(globalBin, { recursive: true, mode: 0o755 });
    symlinkSync(global.binary, join(globalBin, "opencode"));

    expect(resolveOpencodePackageBinaryFromPath(
      `${localBin}:${globalBin}`,
      { expectedVersion: "1.18.1", forbiddenRoots: [project] },
    )).toBe(global.binary);
  });

  test("rejects a monorepo-root package when invoked from a nested app", () => {
    const base = safeTestBase();
    const repo = join(base, "repo");
    const app = join(repo, "packages", "app");
    const localBin = join(repo, "node_modules", ".bin");
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    writeFileSync(join(repo, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["packages/*"],
    }), { mode: 0o664 });
    mkdirSync(app, { recursive: true, mode: 0o700 });
    mkdirSync(localBin, { recursive: true, mode: 0o700 });
    const local = makePackage(repo);
    symlinkSync(local.binary, join(localBin, "opencode"));

    const global = makePackage(join(base, "global"));
    const globalBin = join(base, "global", "bin");
    mkdirSync(globalBin, { recursive: true, mode: 0o755 });
    symlinkSync(global.binary, join(globalBin, "opencode"));

    const forbiddenRoots = discoverOpencodeForbiddenRoots(app);
    expect(forbiddenRoots).toContain(repo);
    expect(resolveOpencodePackageBinaryFromPath(
      `${localBin}:${globalBin}`,
      { expectedVersion: "1.18.1", forbiddenRoots },
    )).toBe(global.binary);
  });

  test("ordinary 0664 checkout package.json does not abort boundary discovery", () => {
    const project = join(safeTestBase(), "plain-project");
    mkdirSync(project, { mode: 0o700 });
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "plain-project",
      private: true,
    }), { mode: 0o664 });
    chmodSync(join(project, "package.json"), 0o664);
    expect(discoverOpencodeForbiddenRoots(project)).toEqual([project]);
  });

  test("accepts both exact registry spellings of bin.opencode", () => {
    const dotted = makePackage(safeTestBase());
    expect(validateOpencodePackageBinary(dotted.binary, {
      expectedVersion: "1.18.1",
    })).toBe(dotted.binary);

    const plain = makePackage(safeTestBase(), { bin: { opencode: "bin/opencode.exe" } });
    expect(validateOpencodePackageBinary(plain.binary, {
      expectedVersion: "1.18.1",
    })).toBe(plain.binary);
  });

  test("rejects forged name, version, and bin metadata", () => {
    for (const override of [
      { name: "attacker-opencode" },
      { version: "1.18.0" },
      { bin: { opencode: "bin/other" } },
    ]) {
      const parent = safeTestBase();
      const fixture = makePackage(parent, override);
      expect(() => validateOpencodePackageBinary(fixture.binary, {
        expectedVersion: "1.18.1",
      })).toThrow("package identity");
    }
  });

  test("rejects world-writable files and package ancestors", () => {
    const first = makePackage(safeTestBase());
    chmodSync(first.binary, 0o777);
    expect(() => validateOpencodePackageBinary(first.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe file ownership or mode");

    const writableBin = makePackage(safeTestBase());
    chmodSync(join(writableBin.root, "bin"), 0o777);
    expect(() => validateOpencodePackageBinary(writableBin.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe directory ownership or mode");

    const writableParent = join(safeTestBase(), "writable-parent");
    mkdirSync(writableParent, { mode: 0o777 });
    chmodSync(writableParent, 0o777);
    const second = makePackage(writableParent);
    expect(() => validateOpencodePackageBinary(second.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe directory ownership or mode");
  });

  test("rejects a symlinked package.json even when its contents are exact", () => {
    const fixture = makePackage(safeTestBase());
    const target = `${fixture.packageJson}.target`;
    renameSync(fixture.packageJson, target);
    symlinkSync(target, fixture.packageJson);
    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toThrow("unsafe file ownership or mode");
  });
});

// #739 — cwd 参与信任判定,而这一点此前没有任何测试覆盖。
//
// 🔴 本 describe 里带「缺陷现状」标记的断言记录的是**当前行为,不是期望行为**。
//    修 #739 时它们应当转红 —— 那正是它们存在的意义:让修复有一个红→绿的信号,
//    而不是靠人回来重读 issue。
//
// 实测复现(同一容器镜像,只改 cwd,包/版本/PATH/二进制路径全部相同):
//   cwd=/            ❌ project/node-local opencode-ai package payload is not trusted
//   cwd=/usr/local   ❌ 同上
//   cwd=/tmp         ✅ smoke passed
//   cwd=/root        ✅ smoke passed
describe("#739 cwd 参与信任判定", () => {
  test("缺陷现状:cwd 为文件系统根时,禁止根含 / —— 与任何包路径都重叠", () => {
    // 机制层面的事实:discoverOpencodeForbiddenRoots 无条件把 cwd 本身放进结果集。
    expect(discoverOpencodeForbiddenRoots("/")).toContain("/");
  });

  test("缺陷现状:cwd=/ 时,一个各方面都合法的包也会被拒", () => {
    const fixture = makePackage(safeTestBase());

    // 基线对照 —— 先证明这个 fixture 本身是可信的,否则下面的红是无意义的:
    // 如果它本来就不合法,再怎么改 forbiddenRoots 都会失败,断言就成了同义反复。
    expect(validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toBe(fixture.binary);

    // 只多传一个 forbiddenRoots: ["/"],同一个 fixture 就被拒了。
    // 变量只有这一个,所以拒因确实来自 cwd,不是来自包本身。
    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
      forbiddenRoots: ["/"],
    })).toThrow("project/node-local");
  });

  test("缺陷现状:cwd 是全局安装前缀的祖先时,全局安装的包被判成项目本地", () => {
    // 复刻 `npm i -g` 的形状:<prefix>/lib/node_modules/opencode-ai,
    // 而用户恰好在 <prefix> 或其祖先下执行 anet(容器里 cwd=/usr/local 就是这种)。
    const prefix = join(safeTestBase(), "usr-local");
    mkdirSync(join(prefix, "lib"), { recursive: true, mode: 0o755 });
    const fixture = makePackage(join(prefix, "lib"));

    expect(validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
    })).toBe(fixture.binary);

    expect(() => validateOpencodePackageBinary(fixture.binary, {
      expectedVersion: "1.18.1",
      forbiddenRoots: [prefix],
    })).toThrow("project/node-local");
  });

  test("这条守卫要防的东西必须继续被防住(修 #739 时不许放宽它)", () => {
    // 这一条**不是**缺陷现状,是必须永远为真的安全属性:
    // checkout 里放一个同版本的 opencode-ai 冒充者,必须被拒。
    // 任何针对 #739 的放宽如果让这条转绿→红,那个修法就是错的。
    const project = join(safeTestBase(), "project");
    mkdirSync(project, { mode: 0o700 });
    const impostor = makePackage(project);
    expect(() => validateOpencodePackageBinary(impostor.binary, {
      expectedVersion: "1.18.1",
      forbiddenRoots: [project],
    })).toThrow("project/node-local");
  });
});
