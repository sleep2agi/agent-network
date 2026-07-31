#!/usr/bin/env bash

set -euo pipefail

cat >&2 <<'EOF'
[anet] setup-anet.sh 已退役，本次未做任何更改。

旧脚本未经端到端验证，并包含批量进程匹配、递归状态删除、不安全的网络默认值和
密钥转发方式，因此已停用。请勿运行以前保存的旧版本。

[anet] setup-anet.sh has been retired and made no changes.

This unverified installer used broad process matching, recursive state deletion,
an unsafe network default, and insecure secret forwarding. It is intentionally
disabled instead of being silently kept as an unsupported installation path.

Use the maintained step-by-step guides:
  中文快速开始: https://anet.sh/guide/getting-started
  中文服务器部署: https://anet.sh/deploy/clean-server
  English quickstart: https://anet.sh/en/guide/getting-started
  English server setup: https://anet.sh/en/deploy/clean-server

Do not run an older saved copy of setup-anet.sh.
EOF

exit 64
