# test1755 — app#225 规则文件端到端（真 hub + 真 agent-node）

```bash
cd <repo> && docker build -f tests/test1755-rules-file-e2e/Dockerfile \
  --build-arg TEST1755_SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-test1755 . && docker run --rm anet-test1755
```

验什么（单测验不了的那几条，见 app#225 验收）：远端节点可用 / 保存落到节点 cwd 的那一个文件 / 目录里没多出别的文件 / 节点离线时 hub 60 s 判 timeout / witnessed-red（文件名映射被改成 `pwned.md` 时套件必须红）。
