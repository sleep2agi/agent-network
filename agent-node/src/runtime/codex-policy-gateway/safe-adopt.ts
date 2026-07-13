// RFC-030 Wave 1A P0.2 Commit 2 corrective round 10 (副指挥
// 9a9a198d / contract v9) — intrinsic-safe adoption of a
// caller-provided Promise into a fresh native Promise.
//
// # Trust boundary
//
// This helper accepts ONLY ORDINARY SAME-REALM BASE NATIVE
// Promises. Everything else is a contract violation and is
// rejected with a synthetic Error WITHOUT invoking any method
// or reading any property beyond the shape check:
//
//   - Promise subclasses (`class X extends Promise {}`)
//   - Cross-realm Promise instances (`vm.runInNewContext`,
//     Worker, iframe)
//   - Any object with an OWN `constructor` descriptor (i.e.
//     the caller has tinkered with the instance)
//   - Foreign thenables (`{ then(res, rej) {...} }`)
//   - Self-thenables (`{ then: this }`)
//   - Anything that is not an `object` or `function`
//
// This is a TRUSTED IN-PROCESS CONTRACT, not a hostile-proof
// shield. §8 production wiring gate verifies at the caller
// boundary that transports/providers return same-realm base
// native Promises. Round 10 does NOT claim to consume an
// out-of-contract original Promise — its later rejection is
// the caller's responsibility.
//
// # Captured intrinsics
//
// All intrinsics are captured at module load time and kept
// MODULE-PRIVATE (no export). Modifications to the global
// `Promise` / `Promise.prototype.then` / `Reflect.apply`
// bindings AFTER this module loads do NOT change these
// references — our captured functions keep working.
//
// Threats not covered:
//   - Modifications made BEFORE this module loads: the
//     captured references ARE the tampered ones. §8
//     trusted-bootstrap failure; safe-adopt cannot detect it.
//   - Modifications to MUTABLE prototype properties that
//     native Promise algorithms read dynamically — e.g.
//     `Promise.prototype.constructor`, `Promise[Symbol.species]`
//     — can still cause a captured `Promise.prototype.then`
//     invocation to fail (or a derived-Promise creation
//     inside the native algorithm to misbehave) BEFORE our
//     attach handlers are installed. `safeAdoptConsume`'s
//     outer try/catch catches such sync throws and routes
//     them to `onCallbackError`. safe-adopt cannot promise
//     that the value's LATE rejection is observed in that
//     case; detection is a §8 concern.
//
// # Rejection reason
//
// `safeAdopt` propagates a caller's rejection reason
// VERBATIM. No `instanceof`, `String()`, `.toString()` or any
// other coercion. Callers who need Error semantics coerce at
// their own layer (`lifecycle.ts` has `toError`).
//
// # `safeAdoptConsume` callback contract
//
// Callbacks return `undefined` — NOT `void`. `void` allows a
// callback to return anything (including a Promise); using
// `undefined` makes TypeScript reject `async` callbacks and
// Promise-returning callbacks at compile time. The
// `typecheck:rfc030-safe-adopt-negative` harness enforces
// this with real `tsc` runs on isolated fixtures.
//
// Callback sync throws are wrapped in try/catch and routed
// to `onCallbackError` (also `undefined`-returning). If
// `onCallbackError` itself throws, the throw is absorbed.
//
// The final captured-intrinsic attach inside `safeAdoptConsume`
// is ALSO wrapped in try/catch. That attach can only throw
// under a trusted-bootstrap failure (see "Threats not covered"
// above). The try/catch guarantee narrows to: a SYNCHRONOUS
// attach exception does NOT escape the caller's stack; it
// routes to `onCallbackError`. This is a defensive branch and
// is NOT exercised by an ordinary invalid input — see
// `safe-adopt.test.ts` for the coverage note.

// ────────────────────────────────────────────────────────────────
// Captured intrinsics (module-private; NOT exported)
// ────────────────────────────────────────────────────────────────

const CAPTURED_NATIVE_PROMISE = Promise;
const CAPTURED_NATIVE_PROMISE_PROTOTYPE = Promise.prototype;
const CAPTURED_NATIVE_THEN = Promise.prototype.then;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;

// ────────────────────────────────────────────────────────────────
// Shape check (module-private)
// ────────────────────────────────────────────────────────────────

/**
 * Trusted prefilter for "ordinary same-realm base native
 * Promise". Three checks, wrapped in a total try/catch so any
 * introspection throw becomes `false` (→ `safeAdopt` routes
 * through the reject path).
 *
 *   1. `value` is an `object` (or `function`) — Promises are
 *      objects; `function` accepted defensively.
 *   2. `getPrototypeOf(value) === Promise.prototype` (identity,
 *      exact, no walk).
 *   3. No OWN `constructor` descriptor on `value` — a caller
 *      who installed their own constructor is out of contract.
 *
 * The FINAL brand check happens at the attach site: only a
 * successful `Reflect.apply(NativeThen, value, [res, rej])`
 * confirms the value is really a base native Promise (e.g.
 * `Object.create(Promise.prototype)` passes all three shape
 * checks but lacks the internal `[[PromiseState]]` slot; its
 * attach throws).
 */
function isBaseNativePromiseShape(value: unknown): boolean {
  try {
    if (value === null) return false;
    const t = typeof value;
    if (t !== "object" && t !== "function") return false;
    if (CAPTURED_OBJECT_GET_PROTOTYPE_OF(value) !== CAPTURED_NATIVE_PROMISE_PROTOTYPE) return false;
    if (CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "constructor") !== undefined) return false;
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Adopt `value` into a FRESH native Promise built via captured
 * `Promise` constructor. `value` must be an ordinary same-realm
 * base native Promise (see module doc); anything else is
 * rejected via a synthetic Error and its properties are NEVER
 * read further.
 *
 * Rejection reason is propagated VERBATIM (no coercion).
 */
export function safeAdopt<T>(value: unknown): Promise<T> {
  return new CAPTURED_NATIVE_PROMISE<T>((resolve, reject) => {
    if (!isBaseNativePromiseShape(value)) {
      reject(new Error("safeAdopt: value is not an ordinary same-realm base native Promise"));
      return;
    }
    // Final brand check: attach via captured intrinsic. On a
    // real base native Promise this succeeds and settlement is
    // routed through our resolve/reject. On a Promise-shaped
    // impostor (e.g. `Object.create(Promise.prototype)`) the
    // internal `[[PromiseState]]` slot is missing, so
    // `Promise.prototype.then` throws a `TypeError` — we
    // catch and reject with a synthetic Error.
    try {
      CAPTURED_REFLECT_APPLY(CAPTURED_NATIVE_THEN, value, [
        (v: T) => resolve(v),
        (reason: unknown) => reject(reason),
      ]);
    } catch {
      reject(new Error("safeAdopt: intrinsic attach failed — value is not a base native Promise"));
    }
  });
}

/** Callback signatures. Return type is `undefined` (not `void`)
 *  so TypeScript rejects `async` / Promise-returning callbacks
 *  at compile time. */
export type SafeAdoptFulfilledCallback = (value: unknown) => undefined;
export type SafeAdoptRejectedCallback = (reason: unknown) => undefined;
export type SafeAdoptCallbackErrorCallback = (reason: unknown) => undefined;

/**
 * Attach-and-forget consumer over `safeAdopt`. Returns `void`
 * — callers must not chain on the result. Callback sync throws
 * are routed to `onCallbackError` (which is itself wrapped in
 * a try/catch so a throwing sink is absorbed).
 *
 * The final captured-intrinsic attach is inside a defensive
 * try/catch that only reaches under a §8 trusted-bootstrap
 * failure; it is not exercised by ordinary invalid inputs.
 */
export function safeAdoptConsume(
  value: unknown,
  onFulfilled?: SafeAdoptFulfilledCallback,
  onRejected?: SafeAdoptRejectedCallback,
  onCallbackError?: SafeAdoptCallbackErrorCallback,
): void {
  const adopted = safeAdopt<unknown>(value);
  const safeInvokeCbErr = (reason: unknown): undefined => {
    try { onCallbackError?.(reason); } catch { /* absorbed */ }
    return undefined;
  };
  const wrappedFul: SafeAdoptFulfilledCallback = (v) => {
    try {
      onFulfilled?.(v);
    } catch (e) {
      safeInvokeCbErr(e);
    }
    return undefined;
  };
  const wrappedRej: SafeAdoptRejectedCallback = (reason) => {
    try {
      onRejected?.(reason);
    } catch (e) {
      safeInvokeCbErr(e);
    }
    return undefined;
  };
  // Defensive: unreachable under trusted-bootstrap invariants.
  // `adopted` is a fresh Promise built via the captured native
  // constructor so `Reflect.apply(NativeThen, adopted, ...)`
  // cannot fail unless native Promise algorithm invariants
  // (constructor / species) have been mutated same-process
  // between our capture and this call — a §8 concern.
  try {
    CAPTURED_REFLECT_APPLY(CAPTURED_NATIVE_THEN, adopted, [wrappedFul, wrappedRej]);
  } catch (e) {
    safeInvokeCbErr(e);
  }
}
