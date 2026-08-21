if (process.argv.includes("--help")) {
  console.log("--runtime codex-app-server");
  process.exit(0);
}
await new Promise(() => {});
