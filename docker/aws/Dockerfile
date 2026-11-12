FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY aws/ ./aws/
COPY shared/ ./shared/
COPY LICENSE ./LICENSE
COPY notices/ ./notices/
COPY models/ ./models/
USER node
CMD ["node", "aws/main.js"]
