// Resolve the listen port from the environment.
//
// `Number(process.env.PORT) || 9200` swallows a legitimate `0`. `Number("0")`
// is `0`, which is falsy, so `PORT=0` — the conventional way to ask the OS for
// an ephemeral port — silently became 9200, the production Hub port.
//
// Three consequences, and the middle one is the worst:
//
//   1. On a host where 9200 is already taken (a running Hub), a test that sets
//      PORT=0 dies with EADDRINUSE and reads as a product bug.
//      task-lifecycle-watcher.test.ts fails on main today for exactly this.
//   2. On a host where 9200 is FREE, the same test passes — by binding 9200.
//      It is green because it grabbed the production port, not because PORT=0
//      worked. Green for the wrong reason is worse than red.
//   3. Anyone asking for an ephemeral port gets the production port instead.
//
// The file already knew: `bootServer` uses `opts.port ?? PORT` with a comment
// saying `||` "would swallow a legitimate 0". The rule was one level up from
// where it was needed.
//
// A malformed value is rejected rather than defaulted. Falling back to 9200 on
// `PORT=abc` means a typo silently starts the server somewhere the operator did
// not ask for — and on this fleet that somewhere is production.

export const DEFAULT_PORT = 9200;

export function resolvePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
  // Unset or empty means "not specified". An empty string is what a shell
  // exports for an unset variable it still passes along, so treating it as 0
  // would make `PORT= anet hub start` bind an ephemeral port by accident.
  if (raw === undefined || raw.trim() === "") return fallback;

  // Decimal digits only, after trimming. `Number()` alone accepts "0x10" (16)
  // and " 9200 ", so a value that does not look like a port would still resolve
  // to one — quietly, and to a different number than the operator typed.
  const text = raw.trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `PORT must be an integer between 0 and 65535 (0 asks the OS for an ephemeral port); got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
