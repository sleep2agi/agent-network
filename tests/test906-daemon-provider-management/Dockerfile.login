# TEST-ONLY login core: no real sign-in, account credentials or inference.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.159.2
RUN openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/fixture-key.pem -out /usr/local/share/ca-certificates/provider906.crt -days 3650 -subj '/CN=chatgpt.com' -addext 'subjectAltName=DNS:chatgpt.com,DNS:localhost,IP:127.0.0.1' && update-ca-certificates
WORKDIR /check
COPY agent-node/src/runtime/codex-managed-login.ts agent-node/src/runtime/codex-managed-login.test.ts agent-node/src/runtime/codex-stdio-client.ts ./
COPY agent-node/src/runtime/codex-login-draft.ts agent-node/src/runtime/codex-login-draft.test.ts ./
COPY agent-node/src/runtime/daemon-codex-logins.ts agent-node/src/runtime/daemon-codex-logins.test.ts ./
COPY tests/test906-daemon-provider-management/login-native.ts ./
COPY tests/test906-daemon-provider-management/native-account-fixture.ts ./
COPY tests/test906-daemon-provider-management/native-routing-fixture.ts ./
CMD ["sh", "-c", "bun test codex-managed-login.test.ts codex-login-draft.test.ts daemon-codex-logins.test.ts && bun login-native.ts"]
