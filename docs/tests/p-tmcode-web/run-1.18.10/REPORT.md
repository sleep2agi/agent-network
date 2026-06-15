# tmcode web smoke — tianma-ai/tmcode#3 (ERR_INVALID_URL fix verify)

**tmcode version:** 1.18.10
**Port:** 38123, **Host:** 127.0.0.1

## Verdict matrix

| Test | Verdict | Evidence |
|---|---|---|
| 1 server-up | PASS | port 38123 bound, process pid 43 alive |
| 2 root-200+html | PASS | GET / → 200, body has <!doctype/<html/<title marker |
| 3 GET-/favicon.ico non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 3 GET-/static non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 3 GET-/index.html non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 4 no ERR_INVALID_URL | PASS | 0 URL-parse errors in server.log |

## Summary
- PASS: 6
- FAIL: 0
- **Verdict: ✅ all PASS — #3 fix verified**

## Server log tail
```
[93m[1m!  TMCODE_SERVER_PASSWORD / OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
timestamp=2026-06-15T04:45:01.534Z level=INFO run=c2be24b7 message=loading path=/root/.config/tmcode/config.json
timestamp=2026-06-15T04:45:01.547Z level=INFO run=c2be24b7 message=loading path=/root/.config/tmcode/opencode.json
timestamp=2026-06-15T04:45:01.547Z level=INFO run=c2be24b7 message=loading path=/root/.config/tmcode/opencode.jsonc
[0m
  ⠀                       ▄    
  ████ █▄▄█ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
  _██_ █^^█ █    █  █ █  █ █▀▀▀
  _▀▀_ ▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀
[0m
[94m[1m  Web interface:     [0m http://127.0.0.1:38123/
```
