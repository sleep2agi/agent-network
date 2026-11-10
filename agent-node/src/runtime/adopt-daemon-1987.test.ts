// #1987 —— 采纳失败时回给 Hub 的**原因码**必须保留真实分支，不能被通用码吞掉。
//
// 现场（2026-10-27）：通信欧2号 的采纳请求连续三次失败，
// 前两次给出了具体原因（`daemon_not_adopt_capable` 配置缺失、`adopt_path_writable_by_others` 目录组可写），
// 第三次却只回 `adopt_local_verification_failed` —— 而真实原因是 `copresence_adopt_v2`
// （copresence 节点按设计不允许被采纳）。
//
// 根因：白名单正则的基段是 `[a-z_]+`，**不允许数字**，而 `copresence_adopt_v2` 末尾就是 `2`。
// 于是一个“设计上正确拒绝”的分支，表现成了“本地校验莫名失败”。
//
// 这个文件钉住三件事：
//   1. 带数字的合法码被保留（`copresence_adopt_v2`）；
//   2. 普通码与带参数码（`adopt_env_not_reproducible:HOME,TMUX`）都保留；
//   3. 路径/OS 错误原文一律折叠成通用码（不能把文件系统细节带出节点）。

import { describe, expect, test } from "bun:test";
import { publicAdoptError } from "./adopt-daemon.js";

describe("#1987 adopt error codes survive the whitelist", () => {
  test("带数字的合法码被保留（这正是本 bug）", () => {
    expect(publicAdoptError("copresence_adopt_v2")).toBe("copresence_adopt_v2");
  });

  test("普通拒绝码被保留", () => {
    for (const code of [
      "adopt_path_writable_by_others",
      "adopt_path_owner_mismatch",
      "adopt_identity_not_found",
      "adopt_process_argv_mismatch",
      "adopt_workdir_outside_roots",
      "cannot_adopt_daemon",
      "daemon_has_node_marker",
      "workdir_not_allowed",
    ]) {
      expect(publicAdoptError(code)).toBe(code);
    }
  });

  test("带参数的码保留参数段", () => {
    expect(publicAdoptError("adopt_env_not_reproducible:HOME,TMUX")).toBe("adopt_env_not_reproducible:HOME,TMUX");
    expect(publicAdoptError("adopt_env_not_reproducible:PATH")).toBe("adopt_env_not_reproducible:PATH");
  });

  test("路径与 OS 错误原文被折叠（不泄露文件系统细节）", () => {
    for (const raw of [
      "/home/someone/work/.anet/nodes/n1: EACCES",
      "ENOENT: no such file or directory, lstat '/home/someone/x'",
      "adopt_something bad",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(publicAdoptError(raw)).toBe("adopt_local_verification_failed");
    }
  });

  test("大小写混入不被放行（码只有小写基段）", () => {
    expect(publicAdoptError("Adopt_path_ok")).toBe("adopt_local_verification_failed");
  });
});
