# Existing offline image only. No install, download, native rebuild or host state.
FROM anet-4150-git-test:local
COPY contracts /work/contracts
COPY server/src /work/server/src
COPY server/scripts /work/server/scripts
COPY agent-node /work/agent-node
COPY agent-network /work/agent-network
COPY tests/test4150-native-project /work/tests/test4150-native-project
WORKDIR /work
ENTRYPOINT ["bun", "tests/test4150-native-project/prepare.ts"]
