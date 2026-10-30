#!/usr/bin/env python3
"""进程跑的是不是它该跑的那份字节 —— 三个交叉判据（只读）。

2026-10-31 —— 起因（一次外部复核，原文要点）：

    「进程有第二个观测点，产物没有。所以『重启判据』这一列的可信度天生高于
      『产物版本』那一列 —— 这不是写法问题，是观测点数量的差别。」

于是把这两类真实事故写成可执行的三条，互不替代：

    ① 产物换了但进程没换：binary mtime > 进程 start_time  ⇒ 跑的是旧二进制
    ② 进程换了但产物没换：readlink /proc/<pid>/exe 以 ' (deleted)' 结尾 ⇒ 持旧 inode
    ③ 交叉：/proc/<pid>/exe 的 sha256 ?= 部署路径的 sha256 ⇒ 才叫「这个 pid 跑的就是这份字节」

用法：
    python3 scripts/report-process-artifact-drift.py --pid 1234
    python3 scripts/report-process-artifact-drift.py --match commhub

只读：不重启、不写、不改权限。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


def boot_time() -> int | None:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except OSError:
        return None
    return None


def proc_start_epoch(pid: int) -> int | None:
    """进程启动时刻（epoch 秒）。字段 22 = 自 boot 起的时钟滴答数。"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2:].split()
    if len(fields) < 20:
        return None
    ticks = int(fields[19])          # ')' 之后从 state 起算 ⇒ 索引 19
    btime = boot_time()
    if btime is None:
        return None
    return btime + ticks // CLK_TCK


def sha256_of(path: str) -> str | None:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def find_pid(match: str) -> int | None:
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", "r", encoding="utf-8") as fh:
                if match in fh.read():
                    return int(entry)
        except OSError:
            continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int)
    ap.add_argument("--match", default=None, help="按 /proc/<pid>/comm 子串找进程")
    ap.add_argument("--artifact-dir", default=None,
                    help="解释型服务的产物目录（三条判据覆盖不到的**业务代码**在这里补）")
    args = ap.parse_args()

    pid = args.pid
    if pid is None:
        if not args.match:
            print("✗ 需要 --pid 或 --match", file=sys.stderr)
            return 2
        pid = find_pid(args.match)
        if pid is None:
            print(f"✗ 没找到 comm 含 {args.match!r} 的进程", file=sys.stderr)
            return 2

    exe_link = f"/proc/{pid}/exe"
    try:
        exe = os.readlink(exe_link)
    except OSError as e:
        print(f"✗ 读不到 {exe_link}: {e}", file=sys.stderr)
        return 2

    started = proc_start_epoch(pid)
    deleted = exe.endswith(" (deleted)")
    real_path = exe[: -len(" (deleted)")] if deleted else exe

    print(f"pid        : {pid}")
    print(f"exe        : {exe}")
    print(f"start_time : {started} ({'-' if started is None else __import__('datetime').datetime.fromtimestamp(started).isoformat(sep=' ')})")

    if deleted:
        print("② 进程持旧 inode：exe 已以 ' (deleted)' 结尾 ⇒ 文件在磁盘上被替换过，进程还跑着老的")
    else:
        print("② 进程持旧 inode：否（exe 未标注 deleted）")

    try:
        bin_mtime = int(os.stat(real_path).st_mtime)
    except OSError:
        print("① 产物换了但进程没换：无法判定（读不到部署路径的 mtime）")
        return 0

    print(f"bin mtime  : {bin_mtime}（{__import__('datetime').datetime.fromtimestamp(bin_mtime).isoformat(sep=' ')}）")
    if started is not None:
        delta = bin_mtime - started
        verdict = "是 → 进程跑的是旧二进制" if delta > 0 else "否（二进制不晚于进程启动）"
        print(f"① 产物换了但进程没换：{verdict}（bin_mtime − start = {delta}s）")

    base = os.path.basename(real_path)
    if base.split(".")[0] in {"bun", "node", "python", "python3", "deno"}:
        # 🔴 对**解释型**服务，进程持有的「产物」不是 exe，而是被加载的脚本/包。
        #    exe 只是解释器 ⇒ 上面三条在这里只覆盖解释器，不覆盖业务代码。
        #    这一句必须打出来，否则读的人会以为「③ 同一份字节」也担保了业务代码没换。
        print("⚠ 解释型运行时：exe 只是解释器（"
              + base + "）⇒ ①②③ 只覆盖解释器，不覆盖业务代码；"
              "业务产物请另用部署目录的 mtime/内容哈希去比。")

    if args.artifact_dir:
        # 解释型服务的「产物」是代码目录，不是 exe ⇒ 这里补那格观测点。
        # 用 max(mtime) 与 start_time 比，是**同一形状的判据**（产物换了但进程没换）。
        newest, newest_path, count = 0, "", 0
        for root, dirs, files in os.walk(args.artifact_dir):
            dirs[:] = [d for d in dirs if d not in {"node_modules", ".git"}]
            for f in files:
                if not f.endswith((".js", ".mjs", ".cjs", ".ts")):
                    continue
                # 测试文件不属于「跑起来的产物」；把它们算进来会让最新 mtime 落在测试上，
                # 于是这条判据测的是「测试什么时候写的」，不是「代码什么时候发布的」。
                if ".test." in f or ".spec." in f:
                    continue
                fp = os.path.join(root, f)
                try:
                    m = int(os.stat(fp).st_mtime)
                except OSError:
                    continue
                count += 1
                if m > newest:
                    newest, newest_path = m, fp
        if count == 0:
            print(f"④ 产物目录 {args.artifact_dir}：没扫到代码文件（不判定）")
        else:
            print(f"④ 产物目录：{count} 个代码文件，最新 mtime {newest}（{__import__('datetime').datetime.fromtimestamp(newest).isoformat(sep=' ')}）")
            print(f"   最新那份：{newest_path}")
            if started is not None:
                d = newest - started
                print(f"   与进程启动之差：{d}s ⇒ "
                      + ("**产物比进程新：进程跑的是旧代码**" if d > 0 else "产物不晚于进程启动（一致）"))

    live = sha256_of(exe_link)      # 读 /proc/<pid>/exe 即读进程实际持有的那份
    on_disk = sha256_of(real_path)
    if live and on_disk:
        same = live == on_disk
        print(f"③ 交叉：exe sha256 {live[:16]}… vs 部署路径 {on_disk[:16]}… ⇒ {'同一份字节' if same else '不是同一份字节'}")
    else:
        print("③ 交叉：无法判定（权限或文件已不可读）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
