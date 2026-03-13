FROM node:20-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM node:20-slim

WORKDIR /app

# Install read-api dependencies
COPY automation/package.json automation/package-lock.json ./automation/
RUN cd automation && npm ci --ignore-scripts

# Copy read-api source + IDL
COPY automation/src/ automation/src/
COPY frontend/src/idl/ frontend/src/idl/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist frontend/dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "--import", "tsx", "automation/src/read-api.ts"]
