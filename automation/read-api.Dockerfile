FROM node:20-slim

WORKDIR /app

COPY automation/package.json automation/package-lock.json ./
RUN npm ci --ignore-scripts

COPY automation/src/ src/
COPY frontend/src/idl/ frontend/src/idl/

CMD ["npm", "run", "read-api"]
