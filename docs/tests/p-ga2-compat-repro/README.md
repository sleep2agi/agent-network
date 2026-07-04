# GA-blocker #2 compat repro

Docker fixtures for the "hub↔agent-node version mismatch" hypothesis that
`通信龙` flagged when a fresh `anet daemon up ga-daemon` on production hub
`:9200` yielded `config_snapshot=None` in `/api/nodes`.

## What's here

- `Dockerfile.aligned` — commhub `0.9.0-preview.21` + agent-node
  `2.5.0-preview.19` + anet `2.3.0-preview.21` (the GA candidate row).
- `Dockerfile.mixed` — commhub `0.9.0-preview.14` + agent-node
  `2.5.0-preview.19` + anet `2.3.0-preview.21` (the exact version combo
  from `通信龙's` production observation).
- `repro.sh` — script both images run. Boots the hub, registers an admin,
  writes the anet global config, kicks `anet daemon up ga-daemon`, then:
  - polls `/api/nodes` every 5 s for 40 s, printing role +
    `LENGTH(config_snapshot)` each pass,
  - dumps the SQL truth from `nodes.config_snapshot`,
  - calls `/api/host-supervisors?network_id=…`,
  - tails the daemon + hub stdout.
- `aligned-full-run.log` / `mixed-full-run.log` — verbatim runs (see the
  parent doc `docs/release/versioning-and-compatibility.md` §9 for
  interpretation).

## Reproduce

```bash
docker build -f Dockerfile.aligned -t anet-ga2-aligned .
docker run --rm --tmpfs /tmp:rw,exec --tmpfs /root:rw,exec anet-ga2-aligned

docker build -f Dockerfile.mixed -t anet-ga2-mixed .
docker run --rm --tmpfs /tmp:rw,exec --tmpfs /root:rw,exec anet-ga2-mixed
```

Both are expected to PASS: `config_snapshot` populated within 1 s of
`anet daemon up`, `list_host_supervisors` returns `count=1` with
`role: host_supervisor`. If either image starts failing after a future
schema change, that's a compat regression worth cataloguing in
`versioning-and-compatibility.md` §4 as its own matrix row.
