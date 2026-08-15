import { describe, expect, test } from "bun:test";

import { describeBlockedKey } from "./blocked-key-name";

describe("describeBlockedKey", () => {
  test("names the legacy control byte for Ctrl+P and says what Grok uses it for", () => {
    // 0x10 is what a terminal without the CSI-u protocol sends for Ctrl+P, and
    // it is what issue #882 observed being blocked as "unknown editor control
    // key".
    expect(describeBlockedKey(Buffer.from([0x10]))).toBe("Ctrl+P (Grok's command palette)");
  });

  test("names Ctrl+P when it arrives CSI-u encoded", () => {
    // ESC [ 112 ; 5 u — codepoint 112 is "p", modifier 5 is ctrl (mask+1).
    expect(describeBlockedKey(Buffer.from("\x1b[112;5u", "binary")))
      .toBe("Ctrl+P (Grok's command palette)");
  });

  test("names CSI-u Ctrl+M as the model picker", () => {
    // The whole point of issue #882's follow-up: on a CSI-u terminal Ctrl+M is
    // distinguishable from Enter and lands on the unknown-sequence route, so
    // this is the one place the proxy can tell a human why the model picker
    // never opened.
    expect(describeBlockedKey(Buffer.from("\x1b[109;5u", "binary")))
      .toBe("Ctrl+M (Grok's model picker; it shares a byte with Enter)");
  });

  test("does not call a plain Tab 'Ctrl+I'", () => {
    // 0x09 reaches the same blocked route as Ctrl+P, and naming it Ctrl+I would
    // report a key the human did not press.
    expect(describeBlockedKey(Buffer.from([0x09]))).toBe("Tab (same byte as Ctrl+I)");
  });

  test("says Enter and Ctrl+M share one byte", () => {
    expect(describeBlockedKey(Buffer.from([0x0d])))
      .toBe("Enter (same byte as Ctrl+M, Grok's model picker)");
  });

  test("reads the CSI-u modifier as a bitmask plus one, not as a raw mask", () => {
    // modifier 2 = shift only. Read naively as a mask, 2 has no ctrl bit either,
    // so the revealing case is modifier 3 (alt): raw-mask reading sees bit 0b10
    // and, if the code tested `modifiers & 4`, would still say no — the case
    // that separates the two readings is 4, which as a mask *does* carry 0b100
    // but as mask+1 means alt+shift with no ctrl.
    expect(describeBlockedKey(Buffer.from("\x1b[112;4u", "binary"))).toBeNull();
    expect(describeBlockedKey(Buffer.from("\x1b[112;2u", "binary"))).toBeNull();
    // 6 = ctrl+shift (mask 0b101) still counts as ctrl.
    expect(describeBlockedKey(Buffer.from("\x1b[112;6u", "binary")))
      .toBe("Ctrl+P (Grok's command palette)");
  });

  test("returns null rather than guessing", () => {
    expect(describeBlockedKey(Buffer.alloc(0))).toBeNull();
    expect(describeBlockedKey(Buffer.from("\x1b[A", "binary"))).toBeNull(); // arrow key
    expect(describeBlockedKey(Buffer.from("\x1b[999;5u", "binary"))).toBeNull(); // not a letter
    expect(describeBlockedKey(Buffer.from([0x1b]))).toBeNull();
    expect(describeBlockedKey(Buffer.from("a", "binary"))).toBeNull(); // ordinary text
  });

  test("names an undocumented control key without inventing a purpose", () => {
    expect(describeBlockedKey(Buffer.from([0x14]))).toBe("Ctrl+T");
  });
});
