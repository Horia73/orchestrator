FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    g++ \
    make \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ARG ORCHESTRATOR_BUILD_COMMIT=unknown
ARG ORCHESTRATOR_BUILD_REF=unknown

ENV NODE_ENV=production \
    ORCHESTRATOR_HOST=0.0.0.0 \
    ORCHESTRATOR_PORT=3000 \
    ORCHESTRATOR_BUILD_COMMIT=${ORCHESTRATOR_BUILD_COMMIT} \
    ORCHESTRATOR_BUILD_REF=${ORCHESTRATOR_BUILD_REF} \
    PORT=3000 \
    HOME=/home/node \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/home/node/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PATCHRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WHATSAPP_CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    ffmpeg \
    git \
    fonts-liberation \
    imagemagick \
    openbox \
    tini \
    tigervnc-standalone-server \
    xauth \
    xclip \
    xdotool \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app /app

RUN npx patchright install chromium \
  && mkdir -p /app/.orchestrator /ms-playwright /home/node/.npm-global /home/node/.npm \
  && chown -R node:node /app/.orchestrator /ms-playwright /home/node

USER node

EXPOSE 3000 6080

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
