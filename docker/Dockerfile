# MALT reviewer service. Built locally by the MALT extension through the Docker Engine API.
# Base image pinned by digest; Claude Code CLI pinned to an exact version.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ARG CLAUDE_CODE_VERSION=2.1.317
RUN npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

WORKDIR /app
COPY reviewer/ ./reviewer/
COPY shared/ ./shared/

ENV NODE_ENV=production \
    HOME=/home/node \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER node
EXPOSE 8787
CMD ["node", "reviewer/main.js"]
