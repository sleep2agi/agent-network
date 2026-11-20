#!/bin/sh
set -eu
echo 'test1260: local TUI history preview proxy (Docker, no host state or credentials)'
node tests/test1260-codex-tui-large-history/launcher-check.cjs
node tests/test1260-codex-tui-large-history/proxy-e2e.cjs
