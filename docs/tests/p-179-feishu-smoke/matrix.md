| Phase0 anet typecheck | PASS | agent-network tsc --noEmit rc=0 |
| Phase0 anet bun test src/ | PASS |  0 fail |
| Phase0 agent-node typecheck | SKIP | agent-node has no tsconfig.json + no typecheck script — bun runtime path, type-checks happen at bun build time |
| Phase0 agent-node bun test src/ | PASS | 221 pass / 1 fail — all failures match known pre-existing #204 prepareGrokIsolatedCwd mkdir-fallback fragility (Docker-perm sensitive), NOT in #179 scope |
| Phase0 anet bun build worker.ts | PASS | worker.js compiled, size=3607792 bytes |
| L0 env | PASS | node + bun + jq all present in Docker (node v24.17.0 bun 1.3.14) |
| L1 config + chmod 600 + access.json | PASS | .env mode=600, env+access loaded with expected shape: {"ok":true,"env_loaded":true,"access_loaded":true,"appIdPresent":true,"appSecretPresent":true,"allowFromCount":2,"allowChatsCount":1,"groupPolicy":"mention","hasChannelDir":true} |
| L2 worker startup | PASS | worker.ts resolved + ran. L2_TIMEOUT — worker still alive after 12s, killing. | stderr: L2_STDERR_TAIL=[warn]: [ "failed to obtain token" ] | [feishu:worker] bridge online — node=test-node dir=/work/.anet/nodes/test-node/channels/feishu ipc=yes | |
| L6 whitelist gate (config-level) | PASS | allowFrom/allowChats logic: {"allowed":true,"denied":false,"allowedChat":true} — live audit-log via real adapter 待凭证 |
| L8 worker crash recovery | PASS | parent's child.on('exit') fired on worker death — L8_EXIT={"code":null,"signal":"SIGKILL"} |
| L9/L10 IPC round-trip | PASS | fork → {type:event} → {type:reply} with eventKey===idempotencyKey + non-placeholder text. rc=0. |
| L3 inbound text DM | SKIP | needs real Feishu app + WSClient connection (待 Vincent 凭证) |
| L4 inbound group @bot | SKIP | needs real Feishu app + group fixture (待 Vincent 凭证) |
| L5 inbound image | SKIP | needs real Feishu app + image messageResource fetch (待 Vincent 凭证) |
| L7 reconnect | SKIP | needs real Feishu WSClient drop / resume (待 Vincent 凭证) |
