// run: bun src/outbound-attachments.test.ts
//
// The load-bearing assertion is the LAST one: with no attachments the request
// body must be byte-identical to what it was before this module existed. Every
// reply on the network goes through that path, so a change there is a change to
// everything.
import fs from "node:fs";
import {
  ATTACHMENTS_SCHEMA,
  attachmentsField,
  attachmentsMeta,
  normalizeOutboundAttachments,
} from "./outbound-attachments";

const server = fs
  .readFileSync(new URL("./node-server.ts", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");
const trace = fs
  .readFileSync(new URL("./channel-task-trace.ts", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");

const ok = (v: unknown) => (normalizeOutboundAttachments(v) as any).attachments;
const err = (v: unknown) => (normalizeOutboundAttachments(v) as any).error ?? "";

const ID_A = "e697d597107f418ba1fe7d71e9464b98";
const ID_B = "dc6c8fe2f16e46c0969e3bcff3d03cf4";

const checks: Array<[string, boolean]> = [
  // ── absent input must change nothing ──
  ["undefined is not an error", normalizeOutboundAttachments(undefined).ok === true],
  ["null is not an error", normalizeOutboundAttachments(null).ok === true],
  ["empty array is not an error", normalizeOutboundAttachments([]).ok === true],
  ["no attachments adds no field at all", JSON.stringify(attachmentsField([])) === "{}"],
  ["no attachments adds no meta at all", JSON.stringify(attachmentsMeta([])) === "{}"],

  // ── the shapes a caller actually types ──
  ["a bare file_id string is accepted", ok([ID_A])[0].file_id === ID_A],
  ["a bare string still gets type:file", ok([ID_A])[0].type === "file"],
  ["an object with file_id is accepted", ok([{ file_id: ID_A }])[0].file_id === ID_A],
  ["name/mime/size are carried through",
    (() => {
      const a = ok([{ file_id: ID_A, name: "chart.png", mime: "image/png", size: 238909 }])[0];
      return a.name === "chart.png" && a.mime === "image/png" && a.size === 238909;
    })()],
  ["two different files are both kept", ok([ID_A, ID_B]).length === 2],

  // ── rejections ──
  ["a non-array is rejected", err("not-an-array").includes("must be an array")],
  ["a missing file_id is rejected", err([{ name: "x.png" }]).includes("file_id")],
  ["a malformed file_id is rejected", err([{ file_id: "../../etc/passwd" }]).includes("file_id")],
  ["a too-short file_id is rejected", err(["abc"]).includes("file_id")],
  ["the rejection names the index", err([ID_A, { name: "x" }]).includes("[1]")],
  ["a duplicate file_id is rejected", err([ID_A, ID_A]).includes("duplicate")],
  ["more than 10 is rejected",
    err(Array.from({ length: 11 }, (_, i) => ID_A.slice(0, -2) + String(i).padStart(2, "0")))
      .includes("too many")],

  // ── malformed optional hints are dropped, not fatal: they never change WHICH
  //    file is fetched, only its label ──
  ["a numeric name is dropped, not rejected",
    (() => { const a = ok([{ file_id: ID_A, name: 42 }]); return a.length === 1 && a[0].name === undefined; })()],
  ["a negative size is dropped, not rejected",
    (() => { const a = ok([{ file_id: ID_A, size: -5 }]); return a.length === 1 && a[0].size === undefined; })()],

  // ── the two carriers differ: reply is top-level, send_task is under meta ──
  ["reply carries attachments at the top level",
    JSON.parse(JSON.stringify(attachmentsField(ok([ID_A])))).attachments[0].file_id === ID_A],
  ["send_task carries them under meta",
    JSON.parse(JSON.stringify(attachmentsMeta(ok([ID_A])))).meta.attachments[0].file_id === ID_A],
  ["send_task preserves other meta keys",
    (() => {
      const m: any = attachmentsMeta(ok([ID_A]), { trace: "abc" });
      return m.meta.trace === "abc" && m.meta.attachments.length === 1;
    })()],
  ["meta alone survives when there are no attachments",
    (() => { const m: any = attachmentsMeta([], { trace: "abc" }); return m.meta.trace === "abc" && !m.meta.attachments; })()],

  // ── wiring: the shim must expose AND forward, not just import ──
  ["node-server declares attachments on commhub_reply",
    /commhub_reply[\s\S]{0,900}?attachments:\s*ATTACHMENTS_SCHEMA/.test(server)],
  ["node-server declares attachments on commhub_send_task",
    /commhub_send_task[\s\S]{0,900}?attachments:\s*ATTACHMENTS_SCHEMA/.test(server)],
  ["the reply path forwards them to send_reply",
    /send_reply[\s\S]{0,400}?\.\.\.attachmentsField\(/.test(server)],
  // Declaring the schema is not sending it: the task path hands `meta` to
  // sendChannelTaskWithTrace, which must both accept and forward it or the
  // attachment vanishes between the tool and the Hub.
  ["the task path builds meta from the parsed list",
    /sendChannelTaskWithTrace[\s\S]{0,400}?\.\.\.attachmentsMeta\(/.test(server)],
  ["sendChannelTaskWithTrace accepts meta",
    /meta\?:\s*Record<string,\s*unknown>;/.test(trace)],
  ["sendChannelTaskWithTrace forwards meta to the Hub",
    /deps\.send\(\{[\s\S]{0,300}?\.\.\.\(input\.meta \? \{ meta: input\.meta \} : \{\}\)/.test(trace)],
  ["a malformed list fails the call instead of being dropped",
    /normalizeOutboundAttachments\([\s\S]{0,200}?if\s*\(!\w+\.ok\)/.test(server)],

  // ── schema copy: it exists to steer agents away from pasting ids into text ──
  ["the schema tells agents not to paste the id into the text",
    /instead of writing the file_id into the message text/.test(ATTACHMENTS_SCHEMA.description)],
  ["the schema names file_id as required",
    (ATTACHMENTS_SCHEMA.items.required as string[]).includes("file_id")],

  // 🔴 The one that guards everything else: a call with no attachments must
  //    produce exactly the body it produced before this module existed.
  ["a reply without attachments is byte-identical to before",
    JSON.stringify({ alias: "api", text: "hi", status: "replied", ...attachmentsField([]) })
      === JSON.stringify({ alias: "api", text: "hi", status: "replied" })],
];

let pass = 0;
for (const [name, good] of checks) {
  if (!good) throw new Error(`FAIL: ${name}`);
  pass += 1;
  console.log(`PASS: ${name}`);
}
console.log(`outbound attachments: ${pass} checks passed`);
