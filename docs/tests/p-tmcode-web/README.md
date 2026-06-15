# tmcode web smoke harness — tianma-ai/tmcode#3

Prepared for SDK马 web-fix verify. **Not yet run** — current `@next` (1.18.8) is the wrapper Windows fix, web fix unfreshed. Awaits SDK马 ping with next 版本号.

## Usage when version is ready

```bash
cd docs/tests/p-tmcode-web/harness
mkdir -p /tmp/p-tmcode-web/run && chmod 0777 /tmp/p-tmcode-web/run
docker build --build-arg TMCODE_VERSION=<NEW_VER> -t tmcode-web:verify . --no-cache
docker run --rm -v /tmp/p-tmcode-web/run:/artifacts tmcode-web:verify
```

## What it verifies

1. `tmcode web --port 38123 --hostname 127.0.0.1` binds the port and stays alive >5s
2. GET / returns HTTP 200 (not the pre-fix 500) AND body has real HTML markers (`<!DOCTYPE`/`<html`/`<title`)
3. 3 additional paths (`favicon.ico`, `static`, `index.html`) return non-500
4. Server stdout/stderr contains 0 `ERR_INVALID_URL` / URL-parse errors

## Files

- `harness/Dockerfile` — node:24-slim base + `@tianma-ai/tmcode@${TMCODE_VERSION}` build-arg
- `harness/entry.sh` — runs the 6 smoke assertions, writes `REPORT.md` + raw bodies + server.log to `/artifacts`

## Dispatch reference

通信龙 task `ab2f7f21-cc4f-4021-8d87-7e2b7b986f81` (2026-06-12). 红线: Docker only, `/tmp/p-tmcode-web` workdir 即清。
