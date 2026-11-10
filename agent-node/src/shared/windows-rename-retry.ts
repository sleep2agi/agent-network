import { renameSync } from "node:fs";

/**
 * Windows: 覆盖一个**正被别的句柄打开**的目标会失败(EPERM/EBUSY/EACCES),而 POSIX 的 rename 会成功 ——
 * 所以同一个"写临时文件再 rename"的原子写在 Linux 上永远绿、在 Windows 上偶发红(#2222 实测在
 * windows-copresence.json 上红过一次,CI 上看起来像随机红)。
 *
 * 这里只做**有界重试**:仅 win32、仅这三种"别人暂时开着"的错误码,退避 10/25/50/100/200ms
 * (最多 5 次,总上限约 385ms);其它错误与重试耗尽一律照原样抛 —— 不吞错,也不把原子写降级成
 * "原地覆盖"(那会让读者读到半个文件)。
 *
 * 为什么不复用 @sleep2agi/agent-network 里那份:agent-node 与 agent-network 是**分别发布**的两个包,
 * 彼此没有依赖;跨包相对路径 import 在发布后会断。语义必须一致,两边的单测都要钉住同一组数字。
 */
export function renameOverExistingSync(
  temp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
  sleep: (ms: number) => void = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  platform: string = process.platform,
): void {
  const backoffMs = [10, 25, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, path);
      return;
    } catch (error: any) {
      const transient = platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(String(error?.code));
      if (!transient || attempt >= backoffMs.length - 1) throw error;
      sleep(backoffMs[attempt]);
    }
  }
}
