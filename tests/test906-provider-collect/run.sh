#!/bin/sh
set -eu
docker build -f tests/test906-provider-collect/Dockerfile -t anet-provider:test906-collect .
docker run --rm --network none anet-provider:test906-collect
