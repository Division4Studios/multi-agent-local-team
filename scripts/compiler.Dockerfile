# Only package manifests and this Dockerfile enter the build context.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /workspace
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit \
 && npm audit --audit-level=low \
 && npm audit signatures \
 && mkdir -p src scripts out
ENV HOME=/tmp
USER node
ENTRYPOINT ["node", "/workspace/node_modules/@typescript/native/bin/tsc"]
