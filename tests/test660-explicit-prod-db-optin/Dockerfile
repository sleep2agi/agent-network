FROM oven/bun:1.3.14

WORKDIR /repo
COPY server/package.json /repo/server/package.json
RUN cd /repo/server && bun install
COPY server /repo/server
COPY tests/test660-explicit-prod-db-optin /repo/tests/test660-explicit-prod-db-optin
RUN chmod +x /repo/tests/test660-explicit-prod-db-optin/run.sh

ARG TEST660_SOURCE_COMMIT=unknown
ENV TEST660_SOURCE_COMMIT=$TEST660_SOURCE_COMMIT

CMD ["bash", "/repo/tests/test660-explicit-prod-db-optin/run.sh"]
