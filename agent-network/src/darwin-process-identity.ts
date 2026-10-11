// Darwin has no /proc. Read kernel process identity and NUL-delimited
// environment directly; ps command text is not environment ownership proof.
import { createRequire } from "node:module";
import type { ProcessEnumerator } from "./copresence-identity";

const requireNative = createRequire(import.meta.url);
const BSD_INFO_SIZE = 136; // sys/proc_info.h: struct proc_bsdinfo, Darwin arm64/x64
let native: ReturnType<typeof loadNative> | undefined;

function loadNative() {
  const koffi = requireNative("koffi");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const proc = koffi.load("/usr/lib/libproc.dylib");
  const errnoPointer = system.func("int *__error(void)");
  return {
    sysctl: system.func("int sysctl(const int *name, unsigned int namelen, void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)"),
    sysctlbyname: system.func("int sysctlbyname(const char *name, void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)"),
    info: proc.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize)"),
    pids: proc.func("int proc_listallpids(void *buffer, int buffersize)"),
    error: () => koffi.decode(errnoPointer(), "int"),
  };
}

function api() {
  if (process.platform !== "darwin") throw new Error("Darwin process API requested on another platform");
  return native ??= loadNative();
}

function nativeError(operation: string): NodeJS.ErrnoException {
  const errno = api().error();
  return Object.assign(new Error(`${operation} failed (errno=${errno})`), {
    // The shared enumerator distinguishes permission denials as EACCES.
    code: ({ 1: "EACCES", 3: "ESRCH", 13: "EACCES", 22: "EINVAL" } as Record<number, string>)[errno] ?? "EIO",
  });
}

export function parseDarwinBsdInfo(raw: Buffer) {
  if (raw.length !== BSD_INFO_SIZE) throw new Error("incomplete Darwin process identity");
  const seconds = Number(raw.readBigUInt64LE(120));
  const micros = Number(raw.readBigUInt64LE(128));
  const birth = seconds * 1_000_000 + micros;
  if (!Number.isSafeInteger(birth) || seconds <= 0 || micros >= 1_000_000) {
    throw new Error("invalid Darwin process birth");
  }
  return {
    pid: raw.readUInt32LE(12), ppid: raw.readUInt32LE(16),
    pgid: raw.readUInt32LE(100), uid: raw.readUInt32LE(28),
    starttime_jiffies: birth, state: raw.readUInt32LE(4) === 5 ? "Z" : "R",
  };
}

function info(pid: number) {
  const raw = Buffer.alloc(BSD_INFO_SIZE);
  const size = api().info(pid, 3, 0, raw, raw.length); // PROC_PIDTBSDINFO
  if (size === 0) {
    const error = nativeError("proc_pidinfo");
    if (error.code === "ESRCH") return null;
    throw error;
  }
  if (size !== raw.length) throw new Error("truncated proc_pidinfo result");
  const row = parseDarwinBsdInfo(raw);
  if (row.pid !== pid) throw new Error("Darwin process identity mismatch");
  return row;
}

/** KERN_PROCARGS2: argc, executable path, padding, exactly argc argv, env. */
export function parseDarwinEnvironment(raw: Buffer): string {
  if (raw.length < 5) throw new Error("truncated KERN_PROCARGS2");
  const argc = raw.readInt32LE(0);
  if (argc < 1 || argc > raw.length) throw new Error("invalid KERN_PROCARGS2 argc");
  let offset = raw.indexOf(0, 4);
  if (offset < 0) throw new Error("missing Darwin executable terminator");
  while (raw[offset] === 0 && offset < raw.length) offset++;
  for (let i = 0; i < argc; i++) {
    const end = raw.indexOf(0, offset);
    if (end < 0) throw new Error("truncated Darwin argv");
    offset = end + 1;
  }
  if (offset < raw.length && raw[raw.length - 1] !== 0) throw new Error("truncated Darwin environment");
  return raw.subarray(offset).toString("utf8");
}

export function darwinBootId(): string {
  const raw = Buffer.alloc(128), size = [raw.length];
  if (api().sysctlbyname("kern.bootsessionuuid", raw, size, null, 0) !== 0) throw nativeError("boot session UUID");
  const uuid = raw.subarray(0, Number(size[0])).toString("utf8").replace(/\0+$/, "");
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error("invalid Darwin boot session UUID");
  return `darwin-${uuid}`;
}

export function darwinEnumerator(): ProcessEnumerator {
  return {
    listAllPids() {
      let count = api().pids(null, 0);
      if (count <= 0) throw nativeError("proc_listallpids");
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = Buffer.alloc((count + 256) * 4);
        const actual = api().pids(raw, raw.length);
        if (actual <= 0) throw nativeError("proc_listallpids");
        if (actual < raw.length / 4) {
          return Array.from({ length: actual }, (_, i) => raw.readInt32LE(i * 4)).filter(pid => pid > 0);
        }
        count = actual * 2;
      }
      throw new Error("Darwin PID enumeration did not converge");
    },
    readStat(pid) {
      const row = info(pid);
      return row && { pgid: row.pgid, ppid: row.ppid, starttime_jiffies: row.starttime_jiffies };
    },
    readOwnerUid(pid) { return info(pid)?.uid ?? null; },
    readState(pid) { return info(pid)?.state ?? null; },
    readEnviron(pid) {
      const before = info(pid);
      if (!before) return null;
      const max = Buffer.alloc(4), maxSize = [4];
      if (api().sysctlbyname("kern.argmax", max, maxSize, null, 0) !== 0) throw nativeError("kern.argmax");
      const capacity = max.readInt32LE();
      if (capacity < 4 || capacity > 8 * 1024 * 1024) throw new Error("invalid Darwin argument buffer limit");
      const raw = Buffer.alloc(capacity), size = [capacity];
      if (api().sysctl(new Int32Array([1, 49, pid]), 3, raw, size, null, 0) !== 0) {
        const error = nativeError("KERN_PROCARGS2");
        if (error.code === "ESRCH") return null;
        throw error;
      }
      const after = info(pid);
      if (!after) return null;
      if (after.starttime_jiffies !== before.starttime_jiffies) throw new Error("PID changed during Darwin environment read");
      return parseDarwinEnvironment(raw.subarray(0, Number(size[0])));
    },
  };
}
