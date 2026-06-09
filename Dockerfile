FROM node:20-slim

# Install system deps for sharp (image processing)
RUN apt-get update && apt-get install -y \
    libvips-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persistent data & cache volumes
RUN mkdir -p /data /cache

ENV DATA_DIR=/data
ENV CACHE_DIR=/cache
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

VOLUME ["/data", "/cache"]

CMD ["node", "server.js"]
