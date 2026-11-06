# MALT's Codex runner: one throwaway container per call, started by the MALT extension through the Docker Engine API
# with no workspace mount, a read-only root filesystem and no capabilities. Base image pinned by digest (the same one
# as the reviewer); Codex CLI pinned to an exact version. ca-certificates lets Codex verify api.openai.com.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ARG CODEX_VERSION=0.163.0
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

WORKDIR /app
COPY run.mjs ./run.mjs

ENV NODE_ENV=production \
    HOME=/home/node

USER node
CMD ["node", "/app/run.mjs"]
