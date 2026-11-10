#!/bin/sh
# Offline fixture only: the exact current source-built paired runtime.
task_runtime_version=$(node -p "require('/opt/test906/node_modules/@sleep2agi/agent-node/package.json').version") || exit 70
if [ "$#" = 3 ] && [ "$1" = -y ] && [ "$2" = "@sleep2agi/agent-node@$task_runtime_version" ] && [ "$3" = --print-entrypoint ]; then
  printf '%s\n' /opt/test906/node_modules/@sleep2agi/agent-node/dist/cli.js
else
  exit 70
fi
