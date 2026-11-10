#!/bin/sh
# Even minimalEnv children use this named, private test socket; never kill-server.
exec /usr/bin/tmux -L test906-native "$@"
