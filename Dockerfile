# Containerised gateway.
#
# The default command runs against a bundled demo config so the image starts and answers
# introspection with no setup — which is what registry health checks need, and also the quickest
# way to see the proxy work. It proxies the included echo server using a placeholder API key, so
# `tools/list` passes through while any real tool call is denied by the fail_closed policy.
#
# For real use, mount your own config and supply a key:
#
#   docker run -i --rm \
#     -e SAFENODE_API_KEY=sn_... \
#     -v /path/to/safenode-gateway.json:/app/config.json \
#     safenode-mcp-gateway --config /app/config.json
#
# Note `-i`: MCP speaks JSON-RPC over stdio, so the container needs stdin attached or the
# gateway has nothing to talk to.

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# Only the one runtime dependency (@modelcontextprotocol/sdk) lands here; the TypeScript
# toolchain stays in the build stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY examples/echo-server.mjs ./examples/echo-server.mjs
COPY docker-demo-config.json ./docker-demo-config.json

# Placeholder so the demo config validates. Override with a real key to evaluate anything.
ENV SAFENODE_API_KEY=sn_demo_key_not_valid_for_evaluation

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "docker-demo-config.json"]
