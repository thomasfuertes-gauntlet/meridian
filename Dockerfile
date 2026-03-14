# ── Stage 1: Build frontend ──────────────────────────────────────
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Vite bakes VITE_* env vars at build time via import.meta.env
ARG VITE_CLUSTER
ARG VITE_RPC_URL
ARG VITE_USDC_MINT
ARG VITE_PROGRAM_ID
ARG VITE_DEV_WALLET
ARG VITE_SIGNAL_URL
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# Install deps (single tree - automation merged into scripts/)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Patch: jito-ts/node_modules/rpc-websockets@7 has no exports field, so Node 22's
# ESM-aware require (via tsx) fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
# Add the missing subpath exports so require('rpc-websockets/dist/lib/client') resolves.
RUN node -e " \
  const fs = require('fs'); \
  const p = 'node_modules/jito-ts/node_modules/rpc-websockets/package.json'; \
  if (!fs.existsSync(p)) { console.log('jito-ts/rpc-websockets not found, skipping patch'); process.exit(0); } \
  const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')); \
  if (!pkg.exports) { \
    pkg.exports = { \
      '.': { require: './dist/index.cjs', default: './dist/index.cjs' }, \
      './dist/lib/client': { require: './dist/lib/client.cjs', default: './dist/lib/client.cjs' }, \
      './dist/lib/client/websocket': { require: './dist/lib/client/websocket.cjs', default: './dist/lib/client/websocket.cjs' }, \
      './dist/lib/client/websocket.browser': { require: './dist/lib/client/websocket.browser.cjs', default: './dist/lib/client/websocket.browser.cjs' } \
    }; \
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2)); \
    console.log('Patched jito-ts/rpc-websockets exports'); \
  } else { \
    console.log('jito-ts/rpc-websockets already has exports, skipping patch'); \
  } \
"

# Copy source
COPY scripts/ ./scripts/
COPY target/idl/ ./target/idl/
COPY target/types/ ./target/types/
COPY tsconfig.json Anchor.toml ./
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Generate deterministic dev wallets
RUN npx tsx scripts/dev-wallets.ts

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8080
CMD ["./entrypoint.sh"]
