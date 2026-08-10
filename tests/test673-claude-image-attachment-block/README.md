# test673 — Claude runtime multimodal-wiring gate (#259 Y)

Locks the previously-untested half of Dashboard image attachments reaching a
Claude-runtime agent's model. Issue **#222** (cross-host attachment fetch) shipped
with a Docker e2e (`tests/qa-222-cross-host-attachments`) that proves the
**download** half (`resolveAttachmentToLocalPath` → local path). Issue **#259 Y**
(`per-model imageCapable gate + real multimodal wiring for claude-agent-sdk`)
shipped the **query** half — building the prompt as an
`AsyncIterable<SDKUserMessage>` with an image content block — but **without a
test**. This test closes that gap.

## What it proves (real inbound path, no mocks of cli.ts)

A commhub task with `meta.attachments=[{type:"file",file_id,mime:"image/png"}]`
drives the real `agent-node/src/cli.ts` path end to end:

```
SSE task  →  extractImagePaths()  →  hub GET /api/files/<id>  (#222 download)
          →  processTask → think → processWithClaude(task, from, images)  (dispatch)
          →  prompt = AsyncIterable<SDKUserMessage> with an image block      (#259 Y)
             { type:"image", source:{ type:"base64", media_type, data } }
          →  claude-agent-sdk query({ prompt })  ← asserted to carry the block
```

`query` is stubbed via `bun --preload sdk-stub-preload.ts` (bun `mock.module`)
so no vendor key or native binary is needed. The stub records the *actual*
prompt `query()` received; the test asserts the image block's base64 equals the
uploaded PNG bytes, and that a text block accompanies it. It also proves the
two narrow sides of the contract: a text-only task still reaches `query()` as
a string prompt, and a profile with `modelImageCapable=false` structurally
cannot emit an image block.

## Witnessed-red mutation

Two exact-anchor, byte-changing mutations are exercised:

1. the dispatch drops `images` while preserving the newer task-evidence
   argument; the turn still runs, but the capture becomes a plain string;
2. the `modelImageCapable` condition is removed; an unverified profile then
   receives an image block and the negative contract turns red.

`cli.ts` is restored after each mutation.

## Run

Docker (exact-SHA):

```
docker build -f tests/test673-claude-image-attachment-block/Dockerfile \
  --build-arg TEST673_SOURCE_COMMIT=$(git rev-parse HEAD) -t test673 .
docker run --rm test673
```

Host (isolated hub + tmp DB, cleans up):

```
REPO=$(pwd) TEST673_SOURCE_COMMIT=$(git rev-parse HEAD) \
  bash tests/test673-claude-image-attachment-block/run.sh
```

The exact PASS count is printed by `run.sh`; acceptance is `FAIL=0` plus both
witnessed-red phases reaching their intended behavior violation.
