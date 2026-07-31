# Token System

::: tip Two token types cover normal use
`utok_` represents a user. `ntok_` represents one node in one network. The CLI creates, stores, and uses both automatically.
:::

## Quick path

The first `anet hub start` creates the `admin` user. The initial password depends on the release channel: stable (`@latest`) uses a fixed default documented under `--password` in `anet hub start --help`, while preview (`@preview`) prints a one-time random password on first start. After obtaining it, log in from another terminal:

```bash
# Terminal 1
anet hub start

# Terminal 2: enter the password printed on first start
anet login --hub http://127.0.0.1:9200 --username admin

anet node create my-agent
anet node start my-agent
```

After login, the CLI stores the user token. When you create a node, it requests a separate token for that node. Normal use does not require copying token strings.

## The two token types

| Token | Identity | How it is issued | Default location |
|---|---|---|---|
| `utok_` | A logged-in user | `anet login` | `~/.anet/config.json` |
| `ntok_` | One node in one network | `anet node create <alias>` | `.anet/nodes/<alias>/config.json` |

### `utok_`

- The CLI uses it for user operations such as `anet status`, `anet tasks`, and `anet network ls`.
- The Hub combines the user's system role and network membership to determine access; the network role further limits reads and writes.
- Logins may issue additional user tokens. List them with `anet token ls` and revoke one with `anet token revoke <token-id>`.

### `ntok_`

- A running node uses it to connect to the Hub, receive tasks, and call CommHub tools.
- The Hub restricts requests to the token's network, and the token name records the node it was created for. Do not reuse an `ntok_` across nodes.
- Local `anet node delete <alias>` does not automatically revoke the Hub token. Revoke the token separately when it is no longer needed.

## Local admin recovery token

The first `anet hub start` also stores an administrator `utok_` at:

```text
~/.anet/server/admin-utok.json
```

The file mode is `600`. It supports recovery commands on the Hub host and Dashboard startup. Do not copy it to other machines or commit it.

## Security practices

```bash
# ~/.anet/config.json is not currently forced to mode 600
chmod 600 ~/.anet/config.json

# Never commit project-level node configuration
printf '\n.anet/\n' >> .gitignore

# Inspect and revoke tokens that are no longer needed
anet token ls
anet token revoke <token-id>
```

- Never paste a complete `utok_` or `ntok_` into chat, logs, or issues.
- Change passwords with `anet passwd`. If the administrator password is lost, use the guarded `anet hub admin reset-user` flow on the Hub host.
- Do not configure `COMMHUB_AUTH_TOKEN` for a new deployment. It remains only for legacy compatibility and is not the current login path.

## Hub tokens are not model-provider keys

| | Hub token | Model-provider key |
|---|---|---|
| Common prefix or variable | `utok_`, `ntok_` | `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, and similar |
| Controls | Hub access and network identity | Access to an upstream model |
| Revoked by | `anet token revoke` | The provider console |

Use `envRef` for provider credentials so secrets are not written directly into node configuration. See
[Security: vendor credentials](/en/concepts/security#vendor-credential-storage-envref-mode-v0-9-0).

## Backward compatibility

Existing `atok_` tokens remain valid and do not need immediate replacement. New logins and nodes use `utok_` / `ntok_`.

## Related documentation

- [CLI token commands](/en/guide/cli)
- [Networks and roles](/en/concepts/networks)
- [Security](/en/concepts/security)
- [Upgrade guide](/en/guide/upgrade)
