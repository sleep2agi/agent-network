if (process.argv.includes("--version")) { console.log("codex-cli 9.9.9"); process.exit(0); }
const listenAt = process.argv.indexOf("--listen");
if (listenAt < 0) process.exit(3);
const url = new URL(process.argv[listenAt + 1]);
Bun.listen({ hostname: url.hostname, port: Number(url.port), socket: { data() {} } });
await new Promise(() => {});
