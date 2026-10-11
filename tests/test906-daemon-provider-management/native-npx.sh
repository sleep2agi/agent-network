#!/bin/sh
# Offline fixture only: the exact current source-built paired runtime.
if [ "$#" = 3 ] && [ "$1" = -y ] && [ "$2" = '@sleep2agi/agent-node@2.5.0-preview.130' ] && [ "$3" = --print-entrypoint ]; then
  printf '%s\n' /opt/test906/node_modules/@sleep2agi/agent-node/dist/cli.js
else
  exit 70
fi
