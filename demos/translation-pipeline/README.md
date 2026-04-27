# Translation Pipeline Demo

Three agents form a translation chain: Chinese -> English -> Japanese.

## Quick Start

```bash
export MINIMAX_API_KEY=sk-cp-your-key-here
docker compose up

# Watch the dispatcher orchestrate
docker compose logs -f dispatcher
```

## Architecture

```
You --> 调度员 (Dispatcher)
              |
              +--> 英文翻译 (EN Translator) --> returns English
              |
              +--> 日文翻译 (JP Translator) --> returns Japanese
              |
              +--> Summary: CN + EN + JP
```

## Stop

```bash
docker compose down -v
```
