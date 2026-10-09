/** Linux user-private-group compatibility for ordinary umask 0002 installs. */
export function opencodeOwnedPathModeIsSafe(
  stat: { uid: number; gid: number; mode: number | bigint },
  runtimeUid = process.getuid?.(),
  runtimeGid = process.getgid?.(),
): boolean {
  if (runtimeUid === undefined) return false;
  if (stat.uid !== runtimeUid && stat.uid !== 0) return false;
  const privateUserGroup = runtimeUid > 0
    && runtimeGid === runtimeUid
    && stat.uid === runtimeUid
    && stat.gid === runtimeUid;
  const forbiddenWriteBits = privateUserGroup ? 0o002 : 0o022;
  return (Number(stat.mode) & forbiddenWriteBits) === 0;
}
