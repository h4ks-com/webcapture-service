FROM node:18-slim AS base

# Skip Puppeteer's bundled Chromium download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /usr/src/app

# Install Chromium and system libraries
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fontconfig                        \
       fonts-liberation                  \
       fonts-noto-core                   \
       fonts-noto-cjk                    \
       fonts-noto-color-emoji            \
       fonts-symbola                     \
       fonts-dejavu-core                 \
       fonts-droid-fallback              \
       libnss3 \
       xdg-utils \
       ffmpeg \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Point Puppeteer to the system Chromium binary
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium


FROM base AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
# Install all dependencies for build (dev & prod)
RUN npm ci


FROM deps AS build
WORKDIR /usr/src/app
COPY tsconfig.json .
COPY src ./src
# Compile TS to JS
RUN npm run build


FROM base AS prod
WORKDIR /usr/src/app

# Copy package manifests for prune step
COPY package.json package-lock.json ./

# Copy built JS and node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=deps  /usr/src/app/node_modules ./node_modules

# Remove devDependencies to slim down
RUN npm prune --production

VOLUME ["/tmp/capture"]

# Run the service
CMD ["node", "dist/index.js"]
