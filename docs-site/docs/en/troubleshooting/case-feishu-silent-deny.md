# Case Study: Feishu Bot "Connected Fine, Messages Vanish"

> A real debugging post-mortem. The bot showed online, logs looked healthy, yet the user's messages never got a reply. The root cause turned out to be neither the network nor the event subscription — it was **a stale identity ID left in the channel's access allowlist after switching Feishu apps**.
>
> This case is worth keeping for two reasons: ① a trap that is very easy to hit after switching apps, with deeply misleading symptoms; ② a discipline of *never jumping from symptom straight to root cause*.

## Symptoms

- The Feishu custom app was switched to a new app (from a task-oriented app to a new IM-capable one).
- The bot process stayed alive and logged `client ready`, `event-dispatch is ready`, and `bridge online`; at the time, those local-initialization markers were misread as proof that the long-lived connection was established. In the current implementation, they do not by themselves prove authentication or WebSocket readiness.
- The user sent "hi" in a direct message and the bot was **completely silent** — no error, no reply.
- Repeated restarts and repeated checks of the Feishu console ("permissions, event subscriptions, published version — all configured") changed nothing.

## Three Wrong Diagnoses (the detours)

Three **wrong** conclusions were reached in turn. Each sounded reasonable, yet none was backed by decisive evidence:

1. **"The new app's published version doesn't subscribe to `im.message.receive_v1`."**
   Based on seeing only task-type events in the log. Plausible — but "I didn't see message events" is not the same as "the subscription is missing."
2. **"Multiple long-connections are competing for events."**
   Repeated restarts did leave orphan connections, and Feishu distributes events across multiple active long-connections of the same app. A **real but non-root-cause** distraction here.
3. **Suspecting the model layer (empty response).**
   Because this model has a known history of "success signal but no extractable text" through certain gateways, the empty reply was briefly blamed on the model. Again, no evidence.

> Lesson: **every "root cause" conclusion should be backed by a decisive log line or experiment — not "the symptom looks like it."** The first three all jumped from symptom to conclusion, so all three were wrong.

## The Decisive Diagnosis

One remark redirected everything: "Forget the container — just test it with the simplest script and you'll know."

So a **minimal standalone script** was written (a raw SDK long-connection, bypassing the entire product stack) using the new app's credentials, subscribing to `im.message.receive_v1` and printing received events. Result:

```
>>>>> GOT im.message.receive_v1 — text="hi" <<<<<
```

**That single line refuted the first two conclusions**: the new app *did* subscribe to message events, and the long-connection *could* receive them. The problem had to be inside the product stack.

Scoping back into the container and cleaning down to a single clean connection, the truly decisive evidence appeared:

```
[feishu:audit] deny from=ou_XXXXXXXX conv=dm — sender not in allowFrom (dm)
```

The message **was received** — but **denied** by the channel's access control.

## Root Cause

In Feishu, both `open_id` (user identity) and `chat_id` (conversation) are **scoped per app** — **the same person has a completely different `open_id` under a different app.**

After switching apps:

- the user's `open_id` under the new app changed;
- but the channel's `access.json` still held the **old app's IDs** in `allowFrom` / `allowChats`;
- so every message hit "sender not in allowlist" → silently denied.

The truth behind "not receiving messages" was "**received, but denied by our own allowlist.**" That `[feishu:audit] deny` line was the smoking gun — which, unfortunately, nobody looked at early on.

## The Fix

Add the user's `open_id` **under the new app** to `allowFrom`, add the DM `chat_id` to `allowChats`, and restart the node so the worker reloads `access.json`:

```jsonc
// <node>/channels/feishu/access.json
{
  "allowFrom": [
    "ou_NEW_APP_OPEN_ID"        // open_id under the NEW app (not the old one!)
  ],
  "allowChats": [
    "oc_NEW_APP_CHAT_ID"        // DM / group chat_id under the new app
  ]
}
```

After the restart, the full round-trip works:

```
[feishu:bridge] placeholder sent ...      # received + placeholder
[claude] success | ... | out>0            # model produced a reply
[feishu:bridge] reply text sent ...        # reply delivered
```

## Three Things You Must Update When Switching Feishu Apps

This is the core checklist of the case. **All three must change; the one most often missed is the third:**

| # | Location | Content |
|---|---|---|
| 1 | Process env / deployment config | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| 2 | `<node>/channels/feishu/.env` | Same as above (the worker actually reads this file, which can override env vars) |
| 3 | **`<node>/channels/feishu/access.json`** | **`allowFrom` / `allowChats` — because `open_id` / `chat_id` change with the app, all old IDs become invalid** |

Classic symptom of missing #3: **real events are visibly reaching the worker, yet the user's messages get "no reaction."**

## General Decision Tree (when the bot doesn't receive messages)

Distilled into a tree that narrows through three layers — connection → subscription → access control:

**Look for connection / authentication errors first, then for real event evidence; do not treat `client ready`, `event-dispatch is ready`, or `bridge online` alone as a success line.**

- **A) `failed to obtain token` appears or `[ws] ws connect failed` repeats**
  = the connection layer has not passed. For the former, check the App ID / Secret and app state; for the latter, check reachability to `https://open.feishu.cn/callback/ws/endpoint` and whether the corporate network / proxy blocks the dynamically returned `wss://...` destination. A simultaneous `bridge online` line does not rule out this branch.

- **B) The Feishu console recognizes the running test connection, but the log has zero events**
  = inspect the **app-side event subscription**. Follow the [official long-lived connection order](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case): start the test client first, then save "Long-lived connection"; subscribe only to `im.message.receive_v1`, then create and publish a version.

- **C) Real events arrive, but the bot doesn't reply** (this case)
  = message received, denied at the **application layer**. **You must grep the log for `deny` / `allowFrom`:**
  - `[feishu:audit] deny ... not in allowFrom` → allowlist problem (most common after switching apps, see above).
  - `empty vendor result` → the model generated output but no text could be extracted (usually a model × gateway response-format mismatch); switch to a compatible model.
  - `No conversation found` → session state invalidated; clear the node's session field and restart.

## Debugging Discipline Worth Keeping

1. **Don't jump from symptom to root cause.** Every "root cause" conclusion needs a decisive log line or a minimal experiment behind it.
2. **Minimal reproduction first.** A standalone script that bypasses the whole product stack often splits the problem in half instantly (platform/network vs. your own code).
3. **Reduce the environment to a single variable first.** Multiple orphan connections and leftover configs make symptoms drift and mislead diagnosis.
4. **Proactively grep for "denied by ourselves" logs like `deny`.** "No reaction" can mean "not received" *or* "received but rejected" — two completely different directions.

## Companion Case: The Bot Can't See Images

A few days later, a trap with **similar symptoms and the same disciplines** — worth keeping alongside.

**Symptom**: send the bot an image and it replies "`[agent-node] received the event but no processable text/image content`". Text messages work fine; only images fail.

**Three wrong diagnoses again** (same bad habit): first "the user is forwarding a card, not a direct image", then "the app lacks image-download permission", then "the model doesn't support vision" — all guesses from symptoms, no evidence.

**The decisive diagnosis**:
1. A sole-connection probe captured the **raw event**: `msg_type=image` with a valid `image_key` — **it's a direct image, refuting the first two guesses**.
2. The key move: the worker's download function was `catch { return null }`, **swallowing every download error**, so the log showed nothing. After **injecting one error-log line** into that catch and resending, it surfaced instantly:

```
[feishu:image] … downloadImage threw: X.on is not a function
```

**Root cause**: the Feishu SDK (lark node-sdk v1.68) `im.messageResource.get()` returns a **wrapper object** (with `.getReadableStream()` / `.writeFile()` methods), **not** a raw stream you can `.on("data")` directly. The old worker called `.on()` on the wrapper → threw → swallowed by the catch → no image bytes → treated as "no content".

**The fix**: `const stream = resp.getReadableStream()` then `stream.on("data", …)`. A one-line difference — and exactly what the official [PR #324](https://github.com/sleep2agi/agent-network/pull/324) (`fix(#179 image): downloadImage SDK misuse`) already fixed. The affected container was running a build from **before #324** (e.g. `2.2.22-preview.2`); upgrading to a preview with the fix resolves it. After the fix, verified end-to-end: image written to disk → `multimodal: 1/1 image(s) attached` → model vision `success` (a 2000+ token reply describing the image) → reply delivered.

**Two disciplines this case adds**:

5. **A silent `catch { return null }` is a prime-suspect anti-pattern.** It hides the real error and leaves you staring at "no reaction". For this class of bug, **step one is to add a log line to the catch** and let the error speak — here, one resend after that pinpointed it.
6. **When behavior doesn't match the latest code, suspect version drift first.** The same bug may already be fixed upstream while your deployment runs an old build. Compare `cat node_modules/<pkg>/package.json` version against `npm view <pkg>@preview version` — often a one-second giveaway.

**Image-recognition checklist**: ① a vision-capable model (MiniMax-M3 / Claude Sonnet / …); ② the node's `flags.modelImageCapable=true`; ③ an agent-network version that includes the [#324](https://github.com/sleep2agi/agent-network/pull/324) download fix (use a recent enough preview). With all three, images are recognized on send.
