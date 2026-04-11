# Password Hash Upgrade Proposal

## Scope

Current implementation:

- `server/src/db.ts` `hashPassword()` uses `sha256("anet:" + password)`
- Call sites:
  - `register()` writes `password_hash`
  - `login()` compares `user.password_hash === hashPassword(password)`
  - `changePassword()` compares old password and writes new hash

Goal:

- move from fast SHA-256 to password hashing designed for credentials
- keep existing users working
- avoid large auth regressions

## Findings

### 1. Does Bun have built-in bcrypt?

Yes.

Local verification on this machine with Bun `1.3.11`:

- `Bun.password.hash`
- `Bun.password.hashSync`
- `Bun.password.verify`
- `Bun.password.verifySync`

`Bun.password.hash()` defaults to `argon2id`, not bcrypt.

If you want bcrypt specifically, Bun supports:

```ts
await Bun.password.hash(password, {
  algorithm: "bcrypt",
  cost: 10,
});
```

And verification:

```ts
await Bun.password.verify(password, storedHash);
```

So there is no need to add a separate `bcrypt` npm package unless you want library-level portability outside Bun runtime.

### 2. Backward compatibility and migration

Existing rows store legacy SHA-256 hex:

- format is deterministic 64-char lowercase hex
- generated from `sha256("anet:" + password)`

Recommended migration strategy:

1. New registrations immediately store bcrypt hashes.
2. Login supports both formats:
   - if stored hash looks like bcrypt (`$2a$`, `$2b$`, `$2y$`) use `Bun.password.verify`
   - if stored hash looks like legacy SHA-256 hex, compare with old `hashPasswordLegacy()`
3. If legacy verification succeeds, rehash the plaintext password to bcrypt and update `users.password_hash` in the same login flow.
4. `changePassword()` should accept either legacy or bcrypt for the old password check, but always write bcrypt for the new password.

This gives zero-downtime migration with no forced reset.

Suggested format detection:

```ts
function isLegacySha256Hash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(hash);
}
```

Notes:

- Do not try to "bulk migrate" without plaintext passwords. It is impossible.
- Login-time lazy migration is the right path here.
- Keep legacy verify support for one or two release cycles, then remove only after most active users have migrated.

### 3. Performance impact and sync blocking

This is the main engineering tradeoff.

Current code is synchronous:

- `register()`
- `login()`
- `changePassword()`
- `hashPassword()`

SHA-256 is cheap, so sync worked before.
Bcrypt is intentionally slow. That is the point.

Implications:

- `hashSync` / `verifySync` would block the Bun event loop for each auth request.
- With low traffic this may be acceptable temporarily.
- Under concurrent login bursts it will increase latency for unrelated requests handled by the same process.

Recommended approach:

- use async `Bun.password.hash` and `Bun.password.verify`
- convert:
  - `register()` to `async`
  - `login()` to `async`
  - `changePassword()` to `async`
- keep token functions and DB calls unchanged
- update `index.ts` call sites to `await register(...)`, `await login(...)`, `await changePassword(...)`

This is a slightly wider change than only `hashPassword()`, but it is the right design if bcrypt is going in.

Cost recommendation:

- start with bcrypt `cost: 10`
- if auth throughput is low and latency budget is fine, `cost: 12` is stronger
- for a single Bun server process, `10` is the safer initial rollout

### 4. Real code impact

Directly affected files:

- `server/src/db.ts`
- `server/src/auth.ts`
- `server/src/index.ts`

Actual required changes:

#### `server/src/db.ts`

Replace current single-purpose helper with explicit legacy + new helpers.

Suggested shape:

```ts
export function hashPasswordLegacy(password: string): string {
  return new Bun.CryptoHasher("sha256").update(`anet:${password}`).digest("hex");
}

export function isLegacyPasswordHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

export function isBcryptPasswordHash(hash: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(hash);
}

export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });
}

export async function verifyPassword(password: string, storedHash: string): Promise<{
  ok: boolean;
  needsUpgrade: boolean;
}> {
  if (isBcryptPasswordHash(storedHash)) {
    return { ok: await Bun.password.verify(password, storedHash), needsUpgrade: false };
  }
  if (isLegacyPasswordHash(storedHash)) {
    const ok = storedHash === hashPasswordLegacy(password);
    return { ok, needsUpgrade: ok };
  }
  return { ok: false, needsUpgrade: false };
}
```

#### `server/src/auth.ts`

Changes:

- `register()` becomes async and writes bcrypt hash
- `login()` becomes async and:
  - verifies via `verifyPassword()`
  - if `needsUpgrade`, updates `users.password_hash` to bcrypt before continuing
- `changePassword()` becomes async and:
  - verifies old password via `verifyPassword()`
  - writes bcrypt hash for new password

Important detail:

- login-time upgrade should happen before token issuance completes, so the DB is corrected as soon as the user successfully authenticates

#### `server/src/index.ts`

Minimal call-site updates:

- `const result = await register(...)`
- `const result = await login(...)`
- `const result = await changePassword(...)`

Route handlers are already `async`, so this is straightforward.

## Recommended implementation plan

### Option A: Recommended

Use Bun built-ins with bcrypt and lazy migration.

Why:

- no extra dependency
- correct password hashing primitive
- backward compatible
- clear rollout story

Plan:

1. Add `hashPasswordLegacy`, `verifyPassword`, format detection helpers in `db.ts`
2. Convert auth functions to async
3. Switch new writes to bcrypt
4. Upgrade legacy hashes on successful login
5. Add tests for both formats

### Option B: Better cryptography, but not bcrypt-specific

Use Bun built-in default `argon2id` instead of bcrypt.

Why:

- Bun already defaults to it
- generally stronger modern default than bcrypt

Why not as primary recommendation:

- your stated target is bcrypt
- if you want a conservative migration with familiar operational tuning, bcrypt is easier to justify right now

If there is no external requirement for bcrypt compatibility, `argon2id` is technically the better long-term choice.

## Test plan required for rollout

Add cases for:

1. Register writes bcrypt hash
2. Login with bcrypt user succeeds
3. Login with legacy SHA-256 user succeeds
4. Legacy login upgrades hash to bcrypt
5. Wrong password still fails for both legacy and bcrypt users
6. `changePassword()` works when current hash is legacy
7. `changePassword()` writes bcrypt
8. No endpoint leaks whether hash format is legacy or bcrypt

## Risks

### Low risk

- Register path
- Change password path
- New user flows

### Medium risk

- Login migration logic if format detection is sloppy
- Synchronous implementation causing latency spikes

### High risk if implemented incorrectly

- Replacing `hashPassword()` only, without updating callers to async
- Using `hashSync`/`verifySync` under moderate traffic
- Treating unknown hash formats as valid legacy hashes

## Final recommendation

Use Bun built-in password APIs and migrate to bcrypt with lazy upgrade on login.

Concretely:

- keep legacy SHA-256 verification for existing rows only
- store bcrypt for all new or updated passwords
- make `register()`, `login()`, and `changePassword()` async
- use `Bun.password.hash(..., { algorithm: "bcrypt", cost: 10 })`
- use `Bun.password.verify()` for bcrypt rows
- upgrade legacy rows to bcrypt immediately after successful login

This is the smallest change that materially improves password security without forcing a mass reset.
