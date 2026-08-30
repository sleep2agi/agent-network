/**
 * #1595 —— `anet doctor` 原先只印 hub 自报的版本:
 *
 *   ✅ CommHub reachable (http://127.0.0.1:9200 v0.9.0-preview.38)
 *
 * 读的人**看不到自己这台 CLI 钉的是哪个**。实测(2026-08-31):生产 hub 在
 * `.38`,而 `anet hub start` 的 `PINNED_SERVER_VERSION` 是 `.44` —— 两个数
 * 差 6 个版本,而屏幕上只有一个。今天有一整条排查(agent→用户消息为什么
 * 验不了端到端)就卡在这个差上:`.44` 之前 `send_desktop_message` 是
 * fire-and-forget 且仍返回 `ok:true`,所以在 `.38` 上拿到的 `ok:true`
 * 不是「用户看到了」的证据。
 *
 * 🔴 **只并排摆出两个数,不判断谁对、不给阈值、不发警告。**
 *    hub 比 CLI 的 pin 老或新都可能完全合理 —— 连的是别人运维的 hub、
 *    本机 hub 还没重启、或者故意钉在旧版。给一个猜出来的「应该一致」
 *    判据,会在这些正常情况下变成误报,而一个会误报的检查第一周就会被关掉。
 *    让读的人自己看见差在哪,是这一格能诚实做到的全部。
 */
export function formatHubVersionDetail(
  hubUrl: string,
  hubVersion: unknown,
  pinnedVersion: string,
): string {
  const v = typeof hubVersion === "string" && hubVersion.trim() ? hubVersion.trim() : "?";
  const base = `${hubUrl} v${v}`;
  // 一致就不多说一句 —— 多数人的多数时候不需要看见 pin。
  if (v === pinnedVersion) return base;
  return `${base}；本机 anet hub start 钉 ${pinnedVersion}`;
}
