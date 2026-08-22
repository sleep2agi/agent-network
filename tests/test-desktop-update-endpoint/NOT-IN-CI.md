# Why this suite is not registered in the global L1 matrix

Verified: 2026-08-22
Revisit-when: the docs-site build workflow stops covering every `docs-site/**` change or the updater endpoint gains server-side logic beyond a Vercel rewrite.

This is a focused, one-time deployment-contract verification for the anet.sh
desktop updater rewrite. The repository's existing `docs-site build` workflow
already runs the production VitePress build for every change under
`docs-site/**`; duplicating the full dependency install and site build in the
global L1 matrix would add cost without covering a distinct runtime boundary.

Run it locally before changing the updater route:

```sh
sg docker -c 'tests/test-desktop-update-endpoint/run.sh'
```

The lightweight route assertion remains available as
`npm run test:update-route` from `docs-site/`.
