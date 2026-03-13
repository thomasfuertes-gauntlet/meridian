FROM node:20-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .

# Vite bakes VITE_* env vars at build time via import.meta.env.
# Railway auto-injects matching env vars as Docker build args.
ARG VITE_RPC_URL
ARG VITE_USDC_MINT
ARG VITE_DEV_WALLET
ARG VITE_SIGNAL_URL
RUN npm run build

FROM node:20-slim

WORKDIR /app
RUN npm i -g serve
COPY --from=frontend-build /app/frontend/dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["serve", "dist", "-s", "-l", "8080"]
