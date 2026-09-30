FROM oven/bun:1.3.14
# Built by run.sh from a temporary context: server/ from this tree (candidate),
# compat/ = this directory, compat/apps/<tag> = shallow clones of the app tags.
ARG BASE_VERSION
RUN test -n "$BASE_VERSION" || { echo "BASE_VERSION (last published commhub-server) is required"; exit 1; }
WORKDIR /base
RUN echo '{"private":true}' > package.json && bun add @sleep2agi/commhub-server@${BASE_VERSION} >/dev/null
WORKDIR /cand/server
COPY server/package.json ./package.json
RUN bun install >/dev/null
COPY server/src ./src
COPY server/bin ./bin
COPY compat /compat
COPY compat/apps /apps
CMD ["bash", "/compat/run-compat.sh"]
