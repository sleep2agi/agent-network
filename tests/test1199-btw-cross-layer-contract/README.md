# test1199 — BTW cross-layer contract

This Docker suite consumes the exact `golden.json` and `schema.json` bytes
vendored by `agent-network-app` PR #177 at head
`ceae98f213f421902635e22ef597dc0f099fdfaa`. The SHA-256 pins turn an
uncoordinated contract edit into a hard failure.

The executable journey drives the App's create/action JSON through the real
Hub HTTP handler and durable coordinator into a dedicated fake Codex node
port, then returns identity-bound terminal events and hydrates through the
real HTTP projection. It proves main-turn non-interference, out-of-order
isolation, local cancel, ACK-loss/restart reconciliation, attachment
preservation, and exactly-once bring-back.

This is a contract E2E, not a claim that production command transport is
wired. Until that transport replaces the fake port and supports attachment
grants plus journaled bring-back, live capability must remain fail-closed.
