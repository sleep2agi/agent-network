# CommHub v0.9.0-preview.242

Built from main at `e39047fb`.

## What changed

**`status` is now computed by one exported pure function, and the test asserts the mapping instead of
the agreement.**

`status` was `statusReasons.length === 0 ? "ok" : "degraded"`, and `status_reasons` is the very same
array — so any assertion of the form "status is ok iff reasons is empty" was true by construction and
protected nothing. The mapping now lives in `statusFromReasons(reasons)`; the test feeds it inputs
(empty, one known reason, one unknown reason) and also checks the live payload against the same
function, so a change that ignores reasons turns red.

Behaviour is unchanged: empty reasons ⇒ `ok`, any reason ⇒ `degraded`.

Also in this tree (no runtime effect): the test-inventory baseline now records a
`definition_sha256` of the extraction predicate (regexes + collector), so widening "what counts as a
test" can no longer pass silently; and the provider-selection test asserts that dependent keys
(`error`, `observed_status`, `hint`) are **absent** when their parent condition is false.

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA
that contains these changes: package `@sleep2agi/commhub-server`, version `0.9.0-preview.242`,
channel preview.

## Install

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.242
```

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.242
```

## Rolling back

`0.9.0-preview.241` computes the same values inline; behaviour is identical.

Do not overwrite published packages.
