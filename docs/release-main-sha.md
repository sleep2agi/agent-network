# npm preview release source

After the release workflow guard is merged, use `release.yml` with `package`,
`version`, `publish=true` and `commit=<full 40-character main SHA>`. Choose a
commit containing the guard. The version must match that commit's package.

The build binds all four gates to the resolved commit. Publishing requires that
exact checkout to be an ancestor of current origin/main, checked before build
and again in the publishing job. Nonpublishing feature-branch checks remain
available with `publish=false`; they do not publish npm packages.

This is a release prerequisite, not production Hub deployment authorization.
No service configuration, port mapping, credentials, or database state changes.
Existing repository secrets remain in GitHub Actions. Published npm versions
are immutable; corrections require a new version, not replacement artifacts.

Focused guard test:

```sh
sg docker -c 'docker build -f tests/release-main-sha/Dockerfile -t anet-release-main-sha .'
sg docker -c 'docker run --rm anet-release-main-sha'
```
