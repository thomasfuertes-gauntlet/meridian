FROM node:20-slim

WORKDIR /app

# Copy package files for dep install
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source (scripts, target IDL types, Anchor config)
COPY scripts/ scripts/
COPY target/types/ target/types/
COPY target/idl/ target/idl/
COPY Anchor.toml .

# Generate deterministic dev wallets
RUN npx tsx scripts/dev-wallets.ts

COPY automation/entrypoint.sh .
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
