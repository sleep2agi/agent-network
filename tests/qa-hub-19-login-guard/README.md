# qa-hub-19-login-guard

Pins #226 login protection behavior without touching any live hub:

- `POST /api/auth/login` allows 10 attempts/minute per IP and returns 429 on the 11th.
- Five wrong passwords lock the username; a correct password during the lock still returns 429.
- After lock expiry, the correct password succeeds and clears the failure state.
- Bearer-token API traffic remains unaffected by login throttling.

The Docker fixture uses a short lock window via env overrides so the expiry path
is tested without a 30 second sleep. Production defaults remain 30s/60s/120s...
up to 15 minutes.
