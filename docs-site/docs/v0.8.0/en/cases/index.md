# Examples And Demo

This is the runnable Agent Network example library. The site only keeps cases with a concrete CLI path, a `demos/` directory, or Docker test coverage. Manual-only examples were removed so the docs do not outrun the code.

## Verified Examples

| Example | Run With | Agents | Verification | Highlight |
|---------|----------|:------:|--------------|-----------|
| Debate Demo | `anet demo debate` | 6 | Docker test27 checks CLI help/list and docs build | Built-in 9-step debate orchestration with an isolated network |
| Hello World | `demos/hello-world` | 2 | Docker Compose assets + Docker test27 docs checks | Simplest two-agent conversation |
| Translation Pipeline | `demos/translation-pipeline` | 3 | Docker Compose assets + Docker test27 docs checks | CN to EN to JP chain translation |
| Telegram Squad | `demos/codex-telegram-squad` | 11 | Docker test23/test24 communication flow + test27 docs checks | 1 commander + 10 workers, Telegram/Dashboard |

## Removed Examples

`Code Review`, `Idiom Chain Game`, and `Mixed Model Collab` were removed from navigation and generated pages. They only had manual instructions and no independent Docker demo or stable automated verification. They can return after matching `demos/` assets and tests exist.

::: tip Before running examples
Complete the [Getting Started guide](/en/guide/getting-started) and prepare the model API keys required by each example. Docker examples should be run from the repository root or their `demos/` subdirectory.
:::
