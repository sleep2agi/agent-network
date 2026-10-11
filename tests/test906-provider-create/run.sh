#!/bin/sh
set -eu
docker build -f tests/test906-provider-create/Dockerfile -t anet-provider:test906-create .
docker run --rm --network none anet-provider:test906-create
