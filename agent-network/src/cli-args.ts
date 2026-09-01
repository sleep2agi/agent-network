export type ParsedCliOptions = {
  [key: string]: string | string[];
  _channels: string[];
  _envs: string[];
};

// Presence-only flags. These must never consume the following positional
// operand as a value. Keep this exact list shared by option and positional
// parsing so the two views of argv cannot drift.
export const BOOLEAN_FLAGS = new Set([
  "--accept-dev-channels",
  "--all",
  "--copresence",
  "--dangerously-allow-full-access",
  "--dev-open",
  "--dry-run",
  "--f",
  "--follow",
  // 🔴 #1736 —— 这两个以前**没登记**,于是 `--force <token>` / `--yes <token>`
  //    会把下一个 token 当成它们的值吃掉。实测:
  //      parseCliOptions(["init","--force","myname"]) → {"force":"myname"}
  //    后果不是「标志没生效」,是**命令作用在别的对象上**:
  //    cli.ts 的 `args[1] && !args[1].startsWith("--") ? args[1] : DAEMON_DEFAULT_NAME`
  //    于是落到默认名 `daemon` —— 用户以为在改 myname。
  //    而且同一个 --force 在两处判真法相反:
  //      cli.ts:8495/:8512  `!opts.force`            → "myname" 是真值 ⇒ 认为开了
  //      cli.ts:11044       `opts.force !== "true"`  → 认为没开
  //    登记进来之后值恒为 "true",两种判法同时正确,也不再吞参数。
  //    已核:全仓没有任何一处读它们的**值**(force 3 处、yes 2 处,全是布尔式)。
  "--force",
  "--grok-headless",
  "--new-session",
  "--no-auto-self",
  "--no-yolo",
  "--resume-latest",
  "--self",
  "--tmux",
  "--yes",
  "--yes-danger-full-access",
]);

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  const result: ParsedCliOptions = { _channels: [], _envs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel" && argv[i + 1]) {
      result._channels.push(argv[++i]);
      continue;
    }
    if (argv[i] === "--env" && argv[i + 1]) {
      result._envs.push(argv[++i]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(argv[i])) {
      result[argv[i].slice(2)] = "true";
      continue;
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      result[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith("--")) {
      result[argv[i].slice(2)] = "true";
    }
  }
  return result;
}

export function positionalArgs(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--channel" || arg === "--env") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(arg) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}
