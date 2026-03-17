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
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# Install deps (single tree - automation merged into scripts/)
# patch-rpc-websockets.cjs must be present before npm ci (postinstall runs during install)
COPY package.json package-lock.json ./
COPY scripts/patch-rpc-websockets.cjs ./scripts/
RUN npm ci --omit=dev

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
