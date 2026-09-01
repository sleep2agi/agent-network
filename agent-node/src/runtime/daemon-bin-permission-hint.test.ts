import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1353 —— 那条闸原来的建议只有 `chmod go-w <abs>`。它**立即可用，但不持久**：
// 若该二进制是 npm 装的，权限由**安装时那个 shell 的 umask** 决定（npm 以 0777/0666
// 建文件再由 umask 掩掉），`umask 0002` 恒得 775/664 —— 2026-09-01 实测：
//
//     umask 0002 → 可执行 775  普通 664     ← 与生产实际逐字相同
//     umask 0022 → 可执行 755  普通 644     ← 755 & 0o022 === 0，过闸
//
// 而 775 & 0o022 !== 0 必然落到这条闸。⇒ chmod 之后**下一次 `npm install -g`
// 会原样改回去**。#1353 正文记着这个坑「历史上已经把人误导过两次」。
//
// 🔴 本测试只钉**源码文本**（建议里同时给出即时修法和持久修法），
//    它不执行那条闸 —— 触发它需要一个真实的 group-writable anet 安装。

const SRC = readFileSync(
  join(import.meta.dir, "create-node-daemon.ts"),
  "utf-8",
);
// 源码里既有「东西」也有「关于它的注释」——去掉注释行再判，否则会命中说明文字。
const CODE = SRC.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("#1353 group/other 可写这条闸的建议既要能立即用，也要说清它会回退", () => {
  it("取集正控：这条闸还在，且判据仍是 mode & 0o022", () => {
    expect(CODE).toContain("writable by group/other");
    expect(CODE).toContain("(st.mode & 0o022) !== 0");
  });

  it("仍然给出立即可用的 chmod（不要为了讲道理把可执行的那条删掉）", () => {
    expect(CODE).toContain("chmod go-w ");
  });

  it("🔴 同时点名持久修法 umask 0022，并说明 chmod 会被重装改回去", () => {
    expect(CODE).toContain("umask 0022");
    expect(CODE).toContain("npm install -g");
  });

  it("只在 group 可写时追加那段说明（other-only 可写与 umask 无关）", () => {
    // umask 0002 的指纹是 group 位;仅 other 可写是另一回事,不该被塞同一段解释。
    expect(CODE).toContain("(st.mode & 0o020) !== 0");
  });

  it("指向 issue，让读的人能查到那两组实测数字", () => {
    expect(CODE).toContain("#1353");
  });
});
