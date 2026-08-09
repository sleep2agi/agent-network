export type TokenCreateNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Parse only `anet token create` operands.
 *
 * The legacy positional form stays supported, while flag parsing is strict so
 * a typo cannot become the name of a newly issued credential.
 */
export function parseTokenCreateName(argv: readonly string[]): TokenCreateNameResult {
  if (argv.length === 0) {
    return { ok: false, error: "token name is required" };
  }

  if (argv.length === 1 && !argv[0].startsWith("--")) {
    return argv[0].trim()
      ? { ok: true, name: argv[0] }
      : { ok: false, error: "token name must not be empty" };
  }

  if (argv.length === 1 && argv[0].startsWith("--name=")) {
    const name = argv[0].slice("--name=".length);
    return name.trim()
      ? { ok: true, name }
      : { ok: false, error: "--name requires a non-empty value" };
  }

  if (argv[0] === "--name") {
    if (argv.length === 1 || !argv[1].trim() || argv[1].startsWith("--")) {
      return { ok: false, error: "--name requires a non-empty value" };
    }
    if (argv.length === 2) return { ok: true, name: argv[1] };
    return { ok: false, error: "unexpected extra token create arguments" };
  }

  if (argv.some((arg) => arg.startsWith("--"))) {
    return { ok: false, error: `unknown token create option: ${argv.find((arg) => arg.startsWith("--"))}` };
  }
  return { ok: false, error: "expected exactly one token name" };
}
