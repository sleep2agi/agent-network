#!/usr/bin/env sh
set -eu

docker build -f tests/test-desktop-update-endpoint/Dockerfile -t anet-desktop-update-endpoint .
docker run --rm anet-desktop-update-endpoint
