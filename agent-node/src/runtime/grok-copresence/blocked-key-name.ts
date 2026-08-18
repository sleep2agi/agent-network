/**
 * Name the key that the co-presence composer gate just refused to forward.
 *
 * Why this exists (issue #882): the gate is correct, but its two catch-all
 * routes report `unknown editor control key` / `unknown terminal control
 * sequence`.  Both are true and neither is usable.  A human who pressed Ctrl+P
 * to open Grok's command palette reads a message about "unknown" keys and has
 * no way to learn that the key exists, that the proxy owns the decision, or
 * that nothing is broken on their end.
 *
 * The key names below are not guesses.  Grok 0.2.93 ships its own keybinding
 * help inside the pinned binary; read out of
 * `~/.commhub/grok-pins/0.2.93/grok` on 2026-08-16 it says:
 *
 *     ### Always available
 *     Command palette:  Ctrl+P or ?
 *     Model picker:     Ctrl+M (from scrollback)
 *     Cancel:           Ctrl+C (see Escape table)
 *     Always-approve:   Ctrl+O
 *
 * 🔴 `Ctrl+M` is `0x0d`, i.e. the *same byte* as Enter.  In a terminal that
 * sends legacy control bytes the proxy therefore consumes it as a submit and it
 * can never reach the TUI as Ctrl+M — no gate fires and no warning is emitted,
 * so the model picker is unreachable in a way that leaves no trace at all.  A
 * terminal speaking the CSI-u ("kitty") keyboard protocol does distinguish it
 * (`ESC [ 109 ; 5 u`), and that form lands on the unknown-sequence route, which
 * is exactly where naming it pays off.
 *
 * Deliberately conservative: return `null` whenever the bytes cannot be named
 * with certainty, so the caller keeps its existing generic message.  This
 * module decides *wording only* — it must never be consulted for whether to
 * forward anything.
 */

/** What the vendor's own help says each key does. Keys are `Ctrl+<LETTER>`. */
const VENDOR_DOCUMENTED_PURPOSE: Readonly<Record<string, string>> = Object.freeze({
  "Ctrl+P": "Grok's command palette",
  "Ctrl+M": "Grok's model picker; it shares a byte with Enter",
  "Ctrl+O": "Grok's always-approve toggle",
});

/** `ESC [ <codepoint> ; <modifiers> u` — the CSI-u / kitty keyboard encoding. */
const CSI_U = /^\x1b\[(\d+)(?:;(\d+))?u/;

/**
 * CSI-u modifiers are encoded as a bitmask **plus one**: 1 = none, 2 = shift,
 * 3 = alt, 5 = ctrl, 9 = super.  Reading the raw number as a mask (a natural
 * mistake) would report Shift+X as a control key.
 */
const CSI_U_CTRL_BIT = 0b100;

/**
 * Four control bytes are also produced by a plain, unmodified key, so calling
 * them `Ctrl+<letter>` would name a key the human did not press.  Say both.
 */
const LEGACY_KEY_COLLISION: Readonly<Record<number, string>> = Object.freeze({
  0x08: "Backspace (same byte as Ctrl+H)",
  0x09: "Tab (same byte as Ctrl+I)",
  0x0a: "Enter (same byte as Ctrl+J)",
  0x0d: "Enter (same byte as Ctrl+M, Grok's model picker)",
});

function nameControlByte(byte: number): string | null {
  const collision = LEGACY_KEY_COLLISION[byte];
  if (collision) return collision;
  // 0x01..0x1a map onto Ctrl+A..Ctrl+Z. 0x00 and 0x1b..0x1f have terminal
  // meanings (NUL, ESC, field separators) that no user "pressed" as a letter.
  if (byte < 0x01 || byte > 0x1a) return null;
  return `Ctrl+${String.fromCharCode(byte + 0x40)}`;
}

function decorate(name: string): string {
  const purpose = VENDOR_DOCUMENTED_PURPOSE[name];
  return purpose ? `${name} (${purpose})` : name;
}

/**
 * Return a human-readable name for the key at the start of `data`, or `null`
 * when it cannot be named.  Only the first key is considered; callers block on
 * the first offending byte anyway.
 */
export function describeBlockedKey(data: Buffer): string | null {
  if (!data.length) return null;

  const csiU = CSI_U.exec(data.toString("binary"));
  if (csiU) {
    const codepoint = Number(csiU[1]);
    const modifiers = csiU[2] === undefined ? 1 : Number(csiU[2]);
    if (!Number.isFinite(codepoint) || !Number.isFinite(modifiers)) return null;
    if (((modifiers - 1) & CSI_U_CTRL_BIT) === 0) return null;
    // CSI-u carries the *unshifted* codepoint, so Ctrl+P arrives as 112 ("p").
    if (codepoint < 0x61 || codepoint > 0x7a) return null;
    return decorate(`Ctrl+${String.fromCharCode(codepoint).toUpperCase()}`);
  }

  if (data[0] === 0x1b) return null; // some other escape sequence; not a named key
  const name = nameControlByte(data[0]);
  return name === null ? null : decorate(name);
}
