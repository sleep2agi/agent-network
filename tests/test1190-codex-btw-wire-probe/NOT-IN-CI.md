# Why test1190 is not in the default CI matrix

Verified: 2026-08-26
Revisit-when: RFC-036's version pin/capability golden changes, or a protected CI job gains a disposable authenticated CODEX_HOME.

This is a version-transition protocol capture, not a product regression suite.
Its authoritative live half needs an authenticated, disposable `CODEX_HOME`
and makes real model calls. Repository CI must not receive or persist that
credential. The credential-free schema half is useful only together with the
same exact `@openai/codex@0.148.0` live capture; running it on every unrelated
change would download the large vendor binary without increasing confidence.

Run both halves manually when RFC-036's Codex pin, capability contract, or
golden changes. A later SideChat adapter PR must add its own credential-free
mock/contract regression suite to normal CI; this exemption does not apply to
that implementation.
