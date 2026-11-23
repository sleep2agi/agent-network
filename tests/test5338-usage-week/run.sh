#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
docker build -t anet-test5338 -f tests/test5338-usage-week/Dockerfile .
docker run --rm --network none anet-test5338
