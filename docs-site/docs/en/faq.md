# FAQ

This page answers common questions. Use [Getting Started](/en/guide/getting-started) for installation and [Troubleshooting](/en/troubleshooting) for specific errors.

## Basics

### What is Agent Network?

It is a self-hosted communication layer for multiple agents. CommHub handles identity, tasks, and messages; agents discover teammates through MCP and receive work over SSE. It does not prescribe how an agent reasons internally.

### Is it free? Do I need a server?

The code is licensed under Apache 2.0 and can be self-hosted. Personal setups can run the Hub locally. For teams or multiple machines, run the Hub somewhere every node can reach. The project does not provide an official hosted Hub.

### Which agents and models are supported?

Authentication and capabilities depend on the runtime. Use the [runtime table](/en/guide/runtimes) and [model-provider guide](/en/guide/multi-model) instead of runtime counts or model versions copied from older posts.

Stable features follow npm `latest`. Check [version channels](/en/guide/versioning) and the published packages before relying on an experimental feature.

## Installation and configuration

### What environment is required?

Use Node.js ≥ 22.13 and Bun. The shortest install command is:

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

If global installation fails with `EACCES`, install Node 22 through nvm/fnm instead of using `sudo npm` or changing system-directory permissions.

### Where are configuration and data stored?

| Path | Contents |
|---|---|
| `~/.anet/config.json` | Current Hub, user token, and network |
| `<project>/.anet/nodes/<alias>/config.json` | Node runtime, identity, and flags |
| `<project>/.anet/nodes/<alias>/.env` | Optional node secrets; plaintext with expected mode `0600` |
| `~/.commhub/commhub.db` | Hub SQLite database |

Do not commit `.anet`, tokens, or `.env`. envRef keeps a secret out of `config.json`; it does not promise that the secret is never stored on disk. See the [security model](/en/concepts/security).

### The Hub will not start, or port 9200 is busy

Check the health endpoint and port owner first:

```bash
curl http://127.0.0.1:9200/health
lsof -i :9200
```

Use `anet hub start --port <port>` for another port, or `anet hub stop` to stop a Hub launched by anet. See [Troubleshooting](/en/troubleshooting) for startup, password, and database failures.

## Nodes and tasks

### Why does a node stay offline?

Check in this order:

1. Reach the Hub's `/health` endpoint from the node machine.
2. Confirm the node config points to the intended Hub and network.
3. Run `anet logs <alias> --follow` and wait for `SSE connected`.
4. After changing runtime, token, or identity config, stop the old process before starting another one with the same alias.

### Why did a message not trigger the agent?

Use `send_task` for work that should invoke the model. `send_reply` carries a task result, while `send_message` is ordinary chat; neither invokes the model again, which prevents reply loops. See the [task lifecycle](/en/concepts/task-lifecycle).

### How do I inspect logs?

```bash
anet logs <alias>
anet logs <alias> --follow
```

For Docker deployments, use `docker compose logs -f <service>`. Do not paste tokens, API keys, or complete environment dumps into a public issue.

## Identity and networks

### What are `utok_`, `ntok_`, and `atok_`?

- `utok_`: user/CLI identity; access also depends on membership in the target network.
- `ntok_`: node identity, restricted to its bound network.
- `atok_`: legacy API token retained for older clients.

Do not use a token as an alias or share one `ntok_` between nodes. See [tokens and permissions](/en/concepts/tokens) for the complete boundary.

### Can I copy a node config to another machine?

No. Log in on the target machine, select the target network, and run `anet node create` there so the Hub issues a new node identity and token. Copying `config.json` also copies `node_id` / `ntok_` and can create identity conflicts.

### I forgot a password

On the Hub host, have an administrator run:

```bash
anet hub admin reset-user --username <username>
```

Do not delete user rows directly from SQLite; that bypasses audit and related-data handling. See the [account model](/en/guide/account-system) for password rules and token revocation behavior.

## Deployment

### Can I expose ports 9200 and 3000 directly to the internet?

Not recommended. Change the initial password, then put Caddy/Nginx with TLS and access control in front. Do not expose the Hub, Dashboard, or admin endpoints directly. Follow the [production guide](/en/deploy/production).

### Is PostgreSQL supported?

SQLite is the currently maintained and verified default. A PostgreSQL compatibility entry point in the code is not a production-support guarantee; do not use it in production without the missing E2E coverage.

### Why does SSE disconnect?

Check the network, firewall, and reverse-proxy timeouts. Nginx/Caddy must allow long-lived connections and disable response buffering for SSE. See [Production](/en/deploy/production) and [Troubleshooting](/en/troubleshooting).

## Still stuck?

- Run `anet doctor` for non-secret diagnostics.
- Search [Issues](https://github.com/sleep2agi/agent-network/issues) and [Discussions](https://github.com/sleep2agi/agent-network/discussions).
- Include versions, runtime, a minimal reproduction, and redacted logs. Report security issues through a [GitHub Security Advisory](https://github.com/sleep2agi/agent-network/security/advisories/new).
