| 1 server-up | PASS | port 38123 bound, process pid 43 alive |
| 2 root-200+html | PASS | GET / → 200, body has <!doctype/<html/<title marker |
| 3 GET-/favicon.ico non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 3 GET-/static non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 3 GET-/index.html non-500 | PASS | HTTP 200 (200 or 404 both acceptable — server handles unknown paths cleanly) |
| 4 no ERR_INVALID_URL | PASS | 0 URL-parse errors in server.log |
