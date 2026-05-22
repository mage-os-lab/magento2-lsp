# Multi-stage build for the Magento 2 LSP / MCP servers.
# Stage 1 compiles TypeScript; stage 2 produces a slim runtime image with
# only the JS bundle and the OS tools the servers shell out to (xmllint, grep).

FROM node:20-alpine AS build
WORKDIR /opt/magento2-lsp
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache libxml2-utils grep
WORKDIR /opt/magento2-lsp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /opt/magento2-lsp/dist ./dist
COPY bin ./bin
COPY src/templates ./src/templates
RUN ln -s /opt/magento2-lsp/bin/magento2-lsp     /usr/local/bin/magento2-lsp \
 && ln -s /opt/magento2-lsp/bin/magento2-lsp-mcp /usr/local/bin/magento2-lsp-mcp
ENTRYPOINT ["node"]
