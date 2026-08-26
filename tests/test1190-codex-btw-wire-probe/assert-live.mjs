import fs from "node:fs";
const x = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const b = x.forkBoundary ?? {}, c = x.concurrencyCancel ?? {}, o = x.reverseCompletion ?? {}, r = x.retention ?? {};
const checks = {
  reviewedEvidenceRevision: x.evidenceRevision === "test1190-wire-v2",
  exactArtifact: x.artifact?.codexCli === "0.148.0" && /^[a-f0-9]{64}$/.test(x.artifact?.binarySha256),
  topology: x.topology === "owned-stdio",
  sourceWasActiveAtFork: b.sourceStatusAtFork === "active",
  authoritativeSourceTurns: JSON.stringify(b.sourceTurnsBefore) === JSON.stringify(["seed", "sourceActive"]),
  exactThroughTurns: JSON.stringify(b.throughTurns) === JSON.stringify(["seed"]),
  exactBeforeTurns: JSON.stringify(b.beforeTurns) === JSON.stringify(["seed"]),
  forkedFromMatches: b.throughForkedFromMatches && b.beforeForkedFromMatches,
  exactIncludeExclude: b.seedIncluded && b.activeExcluded,
  activeInclusiveRejected: b.activeInclusiveBoundaryRejected && b.activeInclusiveBoundaryErrorCode === -32600,
  threeWayActive: c.sourceStartedBeforeForks && c.allThreeActiveBeforeCancel,
  cancelPrecedesAllTerminals: c.cancelRequestedBeforeTargetTerminal && c.cancelRequestedBeforeSiblingTerminal && c.cancelRequestedBeforeSourceTerminal,
  isolatedStatuses: c.targetStatus === "interrupted" && c.siblingStatus === "completed" && c.sourceStatus === "completed",
  cancelReadIsolation: c.sourceReadableAfterCancel && c.siblingReadableAfterCancel,
  reverseSuccessfulCompletion: JSON.stringify(o.creationOrder) === JSON.stringify(["forkSlow", "forkFast"])
    && JSON.stringify(o.completionOrder) === JSON.stringify(["forkFast", "forkSlow"])
    && o.fastStatus === "completed" && o.slowStatus === "completed",
  archiveUnarchive: r.archivedReadable && r.unarchivedReadable,
  deleteAndIsolation: r.deleteReadRejected && r.deleteReadErrorCode === -32600
    && r.sourceIsolatedFromDelete && r.unarchivedSiblingIsolatedFromDelete,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) { console.error(JSON.stringify({ ok: false, failed }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ok: true, checks }, null, 2));
