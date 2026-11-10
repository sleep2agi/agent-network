import { expect, test } from "bun:test";
import { listenInodesInTable } from "./adopt-codex-listen.js";

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

test("listen table keeps only the exact loopback LISTEN inode", () => {
  const text = header + [
    "  5: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 x 100 0 0 10 0",
    "  6: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 9999 1 x 100 0 0 10 0",
    "  7: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 8888 1 x 100 0 0 10 0",
    "  8: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7777 1 x 100 0 0 10 0",
  ].join("\n") + "\n";
  expect([...listenInodesInTable(text, "0100007F", 8080)]).toEqual(["4242"]);
  expect([...listenInodesInTable(text, "00000000000000000000000001000000", 8080)]).toEqual([]);
});
