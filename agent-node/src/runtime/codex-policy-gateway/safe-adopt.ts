// RFC-030 Wave 1A P0.2 Commit 2 corrective round 9 (副指挥
// 7d061fcd + ff8edc19) — intrinsic-safe adoption of a caller-
// provided promise-like into a fresh native Promise.
//
// Every place in the gateway that consumes a caller-provided
// Promise MUST route through `safeAdopt` and `safeAdoptConsume`.
// Otherwise a caller returning a native Promise with an OWN
// poisoned `.then`/`.catch` getter can:
//   - `Promise.race([callerP, ...])` reads `callerP.then` at
//     attach — poisoned getter throws → race constructor throws
//     → other race participants orphaned → their rejections
//     become unhandled.
//   - `callerP.catch(...)` reads `callerP.catch` for the
//     consumer attach — same problem, plus even a normal `.then`
//     chain that internally uses `.catch` (there isn't one, but
//     some Promise combinators do) is unsafe.
//
// `safeAdopt` creates a FRESH native Promise and attaches
// settlement via `Promise.prototype.then.call(caller, res, rej)`
// wrapped in try/catch. Reading `.then` off the caller happens
// exactly ONCE and any getter throw becomes the fresh promise's
// rejection. The returned Promise is native — downstream
// combinators see only native intrinsics.
//
// `safeAdoptConsume` is the "attach and forget" flavour used
// when the caller Promise's outcome doesn't matter for control
// flow but we still need to prevent an `unhandledRejection`
// event. It uses the same intrinsic-safe attach path.

/**
 * Convert any value (including a native Promise with poisoned
 * OWN getters, a foreign thenable, or a non-thenable) into a
 * FRESH native Promise. Instance `.then` is read exactly once
 * inside try/catch; any getter throw becomes a rejection on the
 * fresh promise instead of a synchronous throw at the call site.
 */
export function safeAdopt<T>(value: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (value === null || value === undefined) {
      resolve(value as T);
      return;
    }
    const t = typeof value;
    if (t !== "object" && t !== "function") {
      resolve(value as T);
      return;
    }
    const safeReject = (e: unknown): void => reject(e instanceof Error ? e : new Error(String(e)));
    // Fast path: if `value` is a real Promise (native), we can
    // invoke `Promise.prototype.then` via `.call` — this uses
    // the internal `[[PromiseState]]` slot and NEVER touches the
    // instance's OWN `.then` getter. A poisoned getter on the
    // caller's Promise has zero effect on this path.
    //
    // `value instanceof Promise` uses `Symbol.hasInstance` from
    // the Promise constructor, which native Promise does not
    // override — safe.
    let isNativePromise = false;
    try { isNativePromise = value instanceof Promise; } catch { /* poisoned RHS */ }
    if (isNativePromise) {
      try {
        Promise.prototype.then.call(
          value as Promise<T>,
          (v) => resolve(v as T),
          safeReject,
        );
      } catch (e) {
        safeReject(e);
      }
      return;
    }
    // Foreign thenable path: must read `.then` off the instance.
    // Any getter throw becomes the fresh promise's rejection.
    let thenFn: unknown;
    try {
      thenFn = (value as Record<string, unknown>).then;
    } catch (e) {
      safeReject(e);
      return;
    }
    if (typeof thenFn !== "function") {
      resolve(value as T);
      return;
    }
    try {
      (thenFn as (r: (v: T) => void, j: (e: unknown) => void) => void).call(
        value,
        resolve,
        safeReject,
      );
    } catch (e) {
      safeReject(e);
    }
  });
}

/**
 * Attach a fulfilment + rejection handler safely, returning the
 * FRESH native Promise for optional further chaining. When the
 * caller doesn't need the outcome, the return value can be
 * ignored — the attach itself is what prevents
 * `unhandledRejection`.
 *
 * `onFulfilled` / `onRejected` are OPTIONAL — omit either to
 * pass through. `onRejected` defaults to a silent consumer so
 * "attach and forget" is a one-liner.
 */
export function safeAdoptConsume<T = unknown>(
  value: unknown,
  onFulfilled?: (v: T) => void,
  onRejected?: (e: Error) => void,
): Promise<T> {
  const adopted = safeAdopt<T>(value);
  const rejectionHandler = onRejected ?? (() => { /* silent */ });
  const fulfilHandler = onFulfilled ?? ((_v: T) => { /* silent */ });
  return adopted.then(fulfilHandler, rejectionHandler) as Promise<T>;
}
