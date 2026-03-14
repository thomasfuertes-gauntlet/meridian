# ── Stage 1: Build frontend ──────────────────────────────────────
FROM node:20-slim AS frontend-build
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
FROM node:20-slim
WORKDIR /app

# Install root deps (scripts need anchor, spl-token, etc.)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install automation deps
COPY automation/package.json automation/package-lock.json ./automation/
RUN cd automation && npm ci --omit=dev

# Copy source
COPY scripts/ ./scripts/
COPY automation/src/ ./automation/src/
COPY automation/tsconfig.json ./automation/tsconfig.json
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
