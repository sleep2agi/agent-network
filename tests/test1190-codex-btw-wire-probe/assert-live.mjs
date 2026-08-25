import fs from "node:fs";
const x = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const b = x.observations?.forkBoundary ?? {};
const c = x.observations?.concurrentAndCancel ?? {};
const r = x.observations?.retention ?? {};
const checks = {
  pinnedVersion: x.version === "codex-cli 0.148.0",
  exactCompletedBoundary: b.completedLastTurnWhileLaterActive === true,
  exactBeforeActiveBoundary: b.beforeActiveTurn === true,
  activeLastTurnFailsClosed: b.activeLastTurnRejected === true,
  exactCancelAccepted: c.independentInterruptAccepted === true,
  cancelledOnlyDerived: c.cancelledForkStatus === "interrupted",
  siblingCompleted: c.siblingForkStatus === "completed",
  sourceCompleted: c.sourceStatus === "completed",
  distinctThreads: c.allThreadIdsDistinct === true,
  archiveAccepted: r.archiveAccepted === true,
  archiveIsNotDelete: r.archivedStillReadable === true,
  deleteAccepted: r.deleteAccepted === true,
  deletedCannotRead: r.deletedReadRejected === true,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(JSON.stringify({ ok: false, failed, observations: x.observations }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));
