import { installProcessSurvivalLog } from "./process-survival-log";

const [logDir, mode] = process.argv.slice(2);
if (!logDir || !mode) throw new Error("usage: fixture LOG_DIR MODE");
installProcessSurvivalLog({ logDir });

if (mode === "epipe") {
  process.stdout.write("READY\n");
  setTimeout(() => {
    // More than a pipe buffer, so a closed reader deterministically emits EPIPE.
    process.stdout.write(Buffer.alloc(1024 * 1024, 120));
  }, 80);
  setTimeout(() => process.exit(0), 350);
} else if (mode === "uncaught") {
  setTimeout(() => { throw new Error("deliberate uncaught probe"); }, 20);
} else if (mode === "rejection") {
  setTimeout(() => { void Promise.reject(new Error("deliberate rejection probe")); }, 20);
} else if (mode === "repeat-epipe") {
  const epipe = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
  process.stdout.emit("error", epipe);
  process.stdout.emit("error", epipe);
  process.stderr.emit("error", epipe);
  setTimeout(() => process.exit(0), 20);
} else {
  throw new Error(`unknown fixture mode ${mode}`);
}
