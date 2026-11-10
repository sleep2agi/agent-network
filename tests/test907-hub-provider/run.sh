#!/bin/sh
set -eu
docker build -f tests/test907-hub-provider/Dockerfile -t anet-provider:test907-hub .
docker run --rm --network none anet-provider:test907-hub
