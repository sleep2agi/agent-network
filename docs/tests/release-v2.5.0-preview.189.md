# agent-node 2.5.0-preview.189

Since `.188`: fork survives a slow Hub.

## What changed

```text
session-control-bridge.ts   Hub request timeout 5 s → 20 s default
                            (ANET_SESSION_CONTROL_TIMEOUT_MS, clamped 1 s–60 s)
session-source-transport.ts fork lane runs on its own tick chain, so a slow directory /
                            project round-trip no longer delays the fork pull; child-register
                            calls use the same timeout
cli.ts                      tick failure reason prints "TimeoutError: …" instead of a bare DOMException code (23)
```

Why: from vdev the production Hub answered `/health` with p50 1.6 s, p90 5.1 s, max 8 s. A tick
makes ~6 sequential calls with a 5 s abort each, so ticks failed (`.188` logged reason `23` =
TimeoutError), the fork pull missed the Hub's 15 s evidence challenge, and every fork ended as
`unknown_rotation_required`.

## Verified

- `tsc -p agent-node` = main (80 pre-existing); `session-control-bridge.test.ts` 18 pass
- live: fork of TM基建欧 on vdev (daemon-vdev) after upgrade

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.189
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.189
```

## What it does not do

- Does not fix the Hub's own latency (host load ~33 on 8 cores); that is tracked separately.
- Does not change the Hub's 15 s challenge window (older daemons refuse longer windows).
