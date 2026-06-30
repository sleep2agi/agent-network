/**
 * RFC-020 §17 — IPC envelope rolling-upgrade backward compatibility.
 *
 * The bridge (agent-network worker) and the agent-node parent are
 * separately-deployable processes. During a rolling upgrade either
 * side could be newer than the other:
 *
 *   - new bridge + old agent-node:
 *       envelope ships `attachments` (new) AND `images: string[]` (legacy).
 *       Old agent-node reads `images`, ignores `attachments`. WORKS.
 *
 *   - old bridge + new agent-node:
 *       envelope ships only `images: string[]`, no `attachments`.
 *       New agent-node detects absence of `attachments` and falls back
 *       to `images`. WORKS.
 *
 *   - new bridge + new agent-node:
 *       envelope has both; new agent-node prefers `attachments` (it
 *       carries `file_id` for cross-machine delegation). WORKS BEST.
 *
 * This test asserts the THREE shapes resolve to the same usable
 * descriptor list under the agent-node parsing rules. It's a pure
 * shape test — no IPC subprocess, no hub call.
 *
 * Run: `bun tests/feishu-envelope-compat.test.ts`
 */

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// Mirror the parsing logic in agent-node/src/cli.ts feishu IPC handler.
// Any change to that logic MUST be reflected here AND the live in-container
// probe (post-deploy). Keep these two in lockstep.
interface IncomingEnvelopeShape {
  content?: {
    text?: string;
    images?: string[];
    attachments?: Array<{
      type?: "image" | "file";
      path?: string;
      file_id?: string;
      mime?: string;
      name?: string;
      size?: number;
    }>;
  };
}

function buildAttachmentDescriptors(ev: IncomingEnvelopeShape): Array<{
  path: string;
  file_id?: string;
  mime?: string;
  name?: string;
  size?: number;
}> {
  const fromAttachments = Array.isArray(ev.content?.attachments)
    ? ev.content.attachments
        .filter((a: any) => a && typeof a.path === "string" && a.path.length > 0)
        .map((a: any) => ({
          path: a.path as string,
          file_id: typeof a.file_id === "string" ? a.file_id : undefined,
          mime: typeof a.mime === "string" ? a.mime : undefined,
          name: typeof a.name === "string" ? a.name : undefined,
          size: typeof a.size === "number" ? a.size : undefined,
        }))
    : [];
  if (fromAttachments.length > 0) return fromAttachments;
  const legacy = Array.isArray(ev.content?.images) ? ev.content.images : [];
  return legacy
    .filter((p: any): p is string => typeof p === "string" && p.length > 0)
    .map((p: string) => ({ path: p }));
}

// ── 1. Legacy envelope (old bridge): `images: string[]` only ──────────────
// Equivalent to a pre-§17 worker that doesn't know about attachments.

{
  const env: IncomingEnvelopeShape = {
    content: {
      text: "hi",
      images: ["/work/feishu-attachments/feishu-local/oc_x/y.jpg"],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("legacy: 1 descriptor", desc.length === 1);
  expect("legacy: path preserved", desc[0].path === "/work/feishu-attachments/feishu-local/oc_x/y.jpg");
  expect("legacy: no file_id (older worker can't compute it)", desc[0].file_id === undefined);
}

// ── 2. New envelope: `attachments` populated WITHOUT `images` ─────────────
// Defensive — shouldn't happen in practice but if a future bridge stops
// shipping the legacy field, new code must still resolve.

{
  const env: IncomingEnvelopeShape = {
    content: {
      text: "hi",
      attachments: [
        {
          type: "image",
          path: "/work/feishu-attachments/feishu-local/oc_x/y.jpg",
          file_id: "abc123def456",
          mime: "image/jpeg",
          name: "y.jpg",
          size: 4242,
        },
      ],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("new-only: 1 descriptor", desc.length === 1);
  expect("new-only: file_id present", desc[0].file_id === "abc123def456");
  expect("new-only: mime present", desc[0].mime === "image/jpeg");
  expect("new-only: size present", desc[0].size === 4242);
  expect("new-only: name present", desc[0].name === "y.jpg");
}

// ── 3. New envelope (current bridge): BOTH `images` AND `attachments` ─────
// Rolling-upgrade safe shape — both fields populated. Parser must prefer
// `attachments` (carries file_id).

{
  const env: IncomingEnvelopeShape = {
    content: {
      text: "hi",
      images: ["/work/feishu-attachments/feishu-local/oc_x/y.jpg"],
      attachments: [
        {
          type: "image",
          path: "/work/feishu-attachments/feishu-local/oc_x/y.jpg",
          file_id: "abc123def456",
          mime: "image/jpeg",
          size: 4242,
        },
      ],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("both: 1 descriptor (from attachments, not duplicated)", desc.length === 1);
  expect("both: file_id from attachments takes precedence", desc[0].file_id === "abc123def456");
  expect("both: mime from attachments", desc[0].mime === "image/jpeg");
}

// ── 4. attachments[] with some entries lacking file_id (partial hub fail) ─

{
  const env: IncomingEnvelopeShape = {
    content: {
      text: "two images, hub upload succeeded for first only",
      images: ["/work/feishu-attachments/feishu-local/oc_x/a.jpg", "/work/feishu-attachments/feishu-local/oc_x/b.jpg"],
      attachments: [
        {
          type: "image",
          path: "/work/feishu-attachments/feishu-local/oc_x/a.jpg",
          file_id: "good1",
          size: 100,
          mime: "image/jpeg",
        },
        {
          type: "image",
          path: "/work/feishu-attachments/feishu-local/oc_x/b.jpg",
          // no file_id — hub upload failed for this one
          size: 200,
        },
      ],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("partial: 2 descriptors", desc.length === 2);
  expect("partial: first has file_id", desc[0].file_id === "good1");
  expect("partial: second missing file_id (graceful)", desc[1].file_id === undefined);
  expect("partial: both have paths", !!desc[0].path && !!desc[1].path);
}

// ── 5. Empty / missing content ────────────────────────────────────────────

{
  const env: IncomingEnvelopeShape = { content: { text: "hi" } };
  const desc = buildAttachmentDescriptors(env);
  expect("empty content: 0 descriptors", desc.length === 0);
}

{
  const env: IncomingEnvelopeShape = {};
  const desc = buildAttachmentDescriptors(env);
  expect("missing content: 0 descriptors", desc.length === 0);
}

// ── 6. Malformed attachments entry → filtered ─────────────────────────────

{
  const env: IncomingEnvelopeShape = {
    content: {
      attachments: [
        { type: "image", path: "/valid/path" },
        null as any,
        { type: "image" } as any, // no path
        { path: "" } as any, // empty path
        { type: "image", path: 42 } as any, // non-string path
        { type: "image", path: "/valid/another", file_id: "ok123abc" },
      ],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("malformed-filter: 2 valid descriptors", desc.length === 2);
  expect("malformed-filter: first /valid/path", desc[0].path === "/valid/path");
  expect("malformed-filter: second /valid/another with file_id", desc[1].file_id === "ok123abc");
}

// ── 7. Non-string in legacy images: filtered ──────────────────────────────

{
  const env: IncomingEnvelopeShape = {
    content: {
      images: ["/valid/path", null as any, "" as any, 42 as any, "/other/path"],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("legacy-filter: 2 valid", desc.length === 2);
  expect("legacy-filter: order preserved", desc[0].path === "/valid/path" && desc[1].path === "/other/path");
}

// ── 8. Non-image type in attachments still passes through (file support) ──

{
  const env: IncomingEnvelopeShape = {
    content: {
      attachments: [
        { type: "image", path: "/work/x/a.jpg", file_id: "i1234567" },
        { type: "file", path: "/work/x/b.pdf", file_id: "f1234567", mime: "application/pdf" },
      ],
    },
  };
  const desc = buildAttachmentDescriptors(env);
  expect("mixed types: 2 descriptors (file + image)", desc.length === 2);
  expect("mixed types: file_id preserved on both", desc[0].file_id === "i1234567" && desc[1].file_id === "f1234567");
}

// ── 9. Rolling upgrade simulation ─────────────────────────────────────────
// Three scenarios, all 3 must produce a usable descriptor list.

const SCENARIOS = [
  {
    label: "scenario A: new bridge + old agent-node parses `images` (this test simulates the OLD agent-node parsing logic; new code reads attachments — both yield 1 path)",
    env: {
      content: {
        images: ["/work/x/y.jpg"],
        attachments: [{ type: "image" as const, path: "/work/x/y.jpg", file_id: "abc123abc" }],
      },
    },
    // Old agent-node only knows about images[]; in this test we focus on the
    // NEW agent-node logic. Both branches in `buildAttachmentDescriptors`
    // produce a descriptor with the path.
    expectPaths: ["/work/x/y.jpg"],
    expectFileIds: ["abc123abc"], // new parser uses attachments → has file_id
  },
  {
    label: "scenario B: old bridge + new agent-node (legacy images-only envelope)",
    env: { content: { images: ["/work/x/y.jpg"] } },
    expectPaths: ["/work/x/y.jpg"],
    expectFileIds: [undefined], // no attachments → falls back to images
  },
  {
    label: "scenario C: new bridge + new agent-node",
    env: {
      content: {
        images: ["/work/x/y.jpg"],
        attachments: [
          { type: "image" as const, path: "/work/x/y.jpg", file_id: "xyz999abc", mime: "image/jpeg" },
        ],
      },
    },
    expectPaths: ["/work/x/y.jpg"],
    expectFileIds: ["xyz999abc"],
  },
];

for (const s of SCENARIOS) {
  const desc = buildAttachmentDescriptors(s.env);
  expect(
    `${s.label}: path resolved`,
    JSON.stringify(desc.map((d) => d.path)) === JSON.stringify(s.expectPaths),
    JSON.stringify(desc),
  );
  expect(
    `${s.label}: file_id resolved (new shape preferred when present)`,
    JSON.stringify(desc.map((d) => d.file_id)) === JSON.stringify(s.expectFileIds),
    JSON.stringify(desc),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-envelope-compat tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
