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
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CAD_PYTHON=/usr/bin/python3 \
    CAD_SNAPSHOT_CHROMIUM=/usr/bin/chromium

RUN groupmod --gid 1002 node \
  && usermod --uid 1002 --gid 1002 node \
  && mkdir -p /home/node \
  && chown -R node:node /home/node

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    ffmpeg \
    git \
    g++ \
    fonts-liberation \
    imagemagick \
    make \
    openbox \
    pkg-config \
    tini \
    tigervnc-standalone-server \
    xauth \
    xclip \
    xdotool \
    binutils \
    jq \
    cups-client \
    file \
    netcat-openbsd \
    openssh-client \
    poppler-utils \
    python3 \
    python3-pip \
    ripgrep \
    sqlite3 \
    pandoc \
    libreoffice-impress \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-core \
    qpdf \
    tesseract-ocr \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
  && rm -rf /var/lib/apt/lists/*

# Python document-processing libraries for the in-container agent. The base
# image only pulls a bare python3 transitively (stdlib only, no pip), which
# forced the agent to fall back to raw OOXML zip parsing. Bake the common libs
# in as wheels (lxml/Pillow ship aarch64+amd64 wheels, so no compiler is needed
# in this runner stage) so docx/xlsx/pptx/pdf work directly. PEP 668 marks the
# system env externally-managed; --break-system-packages is the standard escape
# hatch inside a throwaway container image.
RUN pip3 install --break-system-packages --no-cache-dir \
    defusedxml \
    markitdown[pptx] \
    pandas \
    pillow \
    pdf2image \
    pdfplumber \
    pypdfium2 \
    pytesseract \
    python-docx \
    openpyxl \
    reportlab \
    python-pptx \
    pypdf

COPY --from=builder --chown=node:node /app /app

# CAD runtime for the bundled skills/cad skill: cadpy (pulls build123d +
# cadquery-ocp OpenCascade wheels — manylinux aarch64/amd64 both published)
# plus python playwright for snapshot rendering. The snapshot renderer reuses
# the system chromium via CAD_SNAPSHOT_CHROMIUM, so no playwright-managed
# browser download is needed (keeps ~400 MB off the eMMC root filesystem).
RUN pip3 install --break-system-packages --no-cache-dir \
    /app/skills/cad/scripts/packages/cadpy \
    playwright

# Bake build metadata into a file the running app can read directly. We
# can't rely on `git rev-parse HEAD` inside the container (.git is
# .dockerignored) and we can't rely on the ENV var alone — `env_file` in
# docker-compose loads `.env` at runtime, which historically held stale
# values and silently overrode this image's baked ENV. Reading from this
# file removes that footgun.
RUN printf '{"commit":"%s","ref":"%s","builtAt":"%s"}\n' \
      "$ORCHESTRATOR_BUILD_COMMIT" \
      "$ORCHESTRATOR_BUILD_REF" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > /app/.build-info.json \
  && chown node:node /app/.build-info.json \
  && chmod 0644 /app/.build-info.json

RUN npx patchright install chromium \
  && mkdir -p /app/.orchestrator /ms-playwright /home/node/.npm-global /home/node/.npm \
  && chown -R node:node /app/.orchestrator /ms-playwright /home/node

USER node

EXPOSE 3000 6080

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
