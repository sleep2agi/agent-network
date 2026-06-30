/**
 * RFC-020 §16.1 — feishu outbound route decision (pure helper).
 *
 * Single source of truth for the `adapter.send` decision tree that
 * picks among text / interactive card / image (rendered PNG) / file /
 * imagePath outputs. Extracted into a pure module so the production
 * call site AND the unit tests can bind the same function — previously
 * the test mirrored the decision tree in a sibling `pickRoute` helper,
 * which would drift silently if the production tree changed.
 *
 * Inputs are the minimal data the decision needs:
 *
 *   - `text` / `imagePath` / `files` — payload from `NormalizedIMMessage`
 *   - `forceTextOnly` — caption-mode hint (RFC-020 §15.2)
 *   - `mode` — channel-config `outboundRender` (`"plain"` / `"card"` /
 *     `"auto"`, RFC-020 §16)
 *
 * Outputs the chosen `route` plus a short `reason` string for log /
 * debug. The CALLER (adapter.send) actually performs the upload /
 * render side-effects keyed on the route — this function does no I/O.
 *
 * Behavior contract (mirrors adapter.send line-for-line, locked by
 * `feishu-outbound-render-mode.test.ts`):
 *
 *   1. `imagePath` set → `image_upload`
 *   2. `files[0].path` set → `file_upload`
 *   3. `forceTextOnly` true → `text`
 *   4. mode "plain" → `text` (always)
 *   5. mode "card" → `card_short_md` iff `looksLikeMarkdown(text)` AND
 *      NOT `shouldRenderAsImage(text)`; else `text`
 *   6. mode "auto" → `image_render` iff `shouldRenderAsImage(text)`;
 *      else `card_short_md` iff `looksLikeMarkdown(text)`; else `text`
 *   7. unknown mode (defensive default-default) → `text`
 *
 * The production switch in adapter.send may add the actual upload /
 * render / lark API calls keyed on the route, but the route itself
 * is decided HERE. To change the decision, change this file.
 */

import { looksLikeMarkdown } from "./adapter.js";
import { shouldRenderAsImage } from "./markdown-image-renderer.js";

export type OutboundRoute =
  | "image_upload"     // imagePath upload — message.imagePath set
  | "file_upload"      // file_key upload — message.files[0].path set
  | "text"             // msg_type:text (plain or short-text fall-through)
  | "card_short_md"    // schema 1.0 interactive card, markdown element
  | "image_render";    // markdown → PNG → image_key upload (#329 fidelity)

export interface RouteInput {
  text?: string;
  imagePath?: string;
  files?: { name: string; path?: string }[];
  forceTextOnly?: boolean;
  /** `outboundRender` from the channel config. Defaults to "plain" when
   *  absent so a caller that doesn't read the config still gets the
   *  "Vincent default" behavior. */
  mode?: "plain" | "card" | "auto";
}

export interface RouteDecision {
  route: OutboundRoute;
  reason: string;
}

/**
 * Decide the outbound route for a `NormalizedIMMessage` (or a subset
 * of its fields). Pure — no I/O, no SDK calls; safe to call from tests
 * directly.
 */
export function resolveOutboundRoute(input: RouteInput): RouteDecision {
  // 1. Attachment priority — always wins.
  if (input.imagePath) {
    return { route: "image_upload", reason: "imagePath upload" };
  }
  if (input.files && input.files.length > 0 && input.files[0]?.path) {
    return { route: "file_upload", reason: "files[0] upload" };
  }

  const text = input.text ?? "";

  // 2. Caption-mode override (RFC-020 §15.2) — always plain when set.
  if (input.forceTextOnly) {
    return { route: "text", reason: "forceTextOnly hint" };
  }

  // 3. Mode switch.
  const mode = input.mode ?? "plain";

  if (mode === "plain") {
    return { route: "text", reason: "plain mode → text always" };
  }
  if (mode === "card") {
    if (looksLikeMarkdown(text) && !shouldRenderAsImage(text)) {
      return {
        route: "card_short_md",
        reason: "card mode + short markdown → schema 1.0 card",
      };
    }
    return {
      route: "text",
      reason: "card mode + heading/table/long → plain text (NOT PNG)",
    };
  }
  if (mode === "auto") {
    if (shouldRenderAsImage(text)) {
      return { route: "image_render", reason: "auto + heading/table/long → PNG" };
    }
    if (looksLikeMarkdown(text)) {
      return { route: "card_short_md", reason: "auto + short markdown → card" };
    }
    return { route: "text", reason: "auto + plain → text" };
  }

  // Defensive default-default — unreachable given the mode enum.
  return { route: "text", reason: "unknown mode → text floor" };
}
