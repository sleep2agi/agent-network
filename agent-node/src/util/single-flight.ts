export interface SingleFlight<T> {
  run(factory: () => Promise<T>): Promise<T>;
  pending(): Promise<T> | null;
}

/**
 * Coalesce concurrent initializers into one attempt. A rejected attempt is
 * cleared so a later caller can retry; callers during the same attempt observe
 * the same result and cannot spawn duplicate resources.
 */
export function createSingleFlight<T>(): SingleFlight<T> {
  let active: Promise<T> | null = null;

  return {
    run(factory) {
      if (active) return active;
      const attempt = Promise.resolve().then(factory);
      active = attempt;
      void attempt.finally(() => {
        if (active === attempt) active = null;
      }).catch(() => {
        // The original attempt carries the rejection to every caller. This
        // catch only handles the promise returned by finally().
      });
      return attempt;
    },
    pending() {
      return active;
    },
  };
}
