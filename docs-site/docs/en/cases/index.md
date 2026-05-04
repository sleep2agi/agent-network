# Examples

Current Agent Network examples, from simple to complex. Examples with a matching `demos/` directory can be launched with Docker; the rest are manual flows using the current CLI and Dashboard.

## Beginner

| Example | Difficulty | Agents | Models | Highlight |
|---------|:----------:|:------:|--------|-----------|
| [Hello World](/en/cases/hello-world) | ★ | 2 | MiniMax | Simplest two-agent conversation |
| [Translation Pipeline](/en/cases/translation-pipeline) | ★★ | 3 | MiniMax + DeepSeek | CN→EN→JP chain translation |
| [Code Review](/en/cases/code-review) | ★★ | 3 | Claude + DeepSeek | Write code + auto review |

## Advanced

| Example | Difficulty | Agents | Models | Highlight |
|---------|:----------:|:------:|--------|-----------|
| [Idiom Chain Game](/en/cases/idiom-chain) | ★★★ | 5 | MiniMax | Multi-agent game |
| [Telegram Squad](/en/cases/telegram-squad) | ★★★★ | 11 | Codex + MiniMax | 1 commander + 10 workers, Docker |
| [Mixed Model Collab](/en/cases/mixed-model) | ★★★ | 4 | Claude + MiniMax + DeepSeek | Different models for different tasks |

::: tip Before running examples
Make sure you've completed the [Getting Started guide](/en/guide/getting-started) and the CommHub server is running.

Placeholder and unsupported industry examples have been removed. For a verified start, run `demos/hello-world` or `demos/translation-pipeline` first.
:::
