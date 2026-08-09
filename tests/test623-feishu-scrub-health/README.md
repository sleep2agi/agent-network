# test623 — Feishu scrub and health hardening

This suite verifies issue #618 in an isolated Docker build:

- access-token shapes not equal to configured app credentials are redacted;
- inbound-dispatch errors pass through the same sanitizer before health/audit;
- `onReconnected` cannot report online before the first authoritative
  `onReady` callback;
- removing each guard is a witnessed-red mutation.
