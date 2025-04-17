FROM node:18-slim

# Install ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Create app dir
WORKDIR /usr/src/app

# Copy manifests
COPY package.json package-lock.json tsconfig.json ./

# Install deps
RUN npm ci --only=production

# Copy source
COPY src ./src

# Build TS
RUN npm run build

# Create tmp dir
RUN mkdir -p /tmp/capture
VOLUME ["/tmp/capture"]

ENV TMP_DIR=/tmp/capture
EXPOSE 3000

CMD [ "npm", "start" ]
