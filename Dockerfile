FROM node:22-bookworm-slim

WORKDIR /usr/src/app

ENV NODE_ENV=production

# PDF.js font fallback and native canvas are more reliable on glibc than musl.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fontconfig fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
