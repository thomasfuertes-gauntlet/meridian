FROM node:20-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM node:20-slim

WORKDIR /app
RUN npm i -g serve
COPY --from=frontend-build /app/frontend/dist ./dist

ENV PORT=8080
EXPOSE 8080

CMD ["serve", "dist", "-s", "-l", "8080"]
