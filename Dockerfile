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
# Runtime dependencies are copied from the stable deps stage. Keeping them out
# of the changing application tree lets consecutive release images (including
# the one-slot rollback image) share the ~1.4 GB node_modules layer.
RUN rm -rf /app/node_modules /app/.next/cache

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    ORCHESTRATOR_HOST=0.0.0.0 \
    ORCHESTRATOR_PORT=3000 \
    PORT=3000 \
    HOME=/home/node \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/home/node/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PATCHRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WHATSAPP_CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CAD_PYTHON=/usr/bin/python3 \
    CAD_SNAPSHOT_CHROMIUM=/usr/bin/chromium \
    # OOM backstop (2026-06-21 incident): cap V8's old-space so a heap runaway
    # crashes THIS process for a fast restart instead of dragging the whole
    # 16 GB host into a kernel OOM that can take neighbour containers down. The
    # agent concurrency gate (lib/ai/concurrency-gate.ts) is the real fix; this
    # is belt-and-suspenders. Override NODE_OPTIONS on a larger box.
    NODE_OPTIONS=--max-old-space-size=6144

RUN groupmod --gid 1002 node \
  && usermod --uid 1002 --gid 1002 node \
  && mkdir -p /home/node \
  && chown -R node:node /home/node

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    dnsutils \
    ffmpeg \
    git \
    g++ \
    fonts-liberation \
    imagemagick \
    librsvg2-bin \
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
    unzip \
    zip \
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
    opencv-python-headless \
    pandas \
    pillow \
    pdf2image \
    pdfplumber \
    pypdfium2 \
    pytesseract \
    python-docx \
    openpyxl \
    reportlab \
    scikit-image \
    shapely \
    python-pptx \
    pypdf

# Stable Node runtime + Patchright browser. These layers depend only on the
# lockfile, not on the per-release source tree or build commit.
COPY --from=deps --chown=node:node /app/package.json /app/package-lock.json /app/
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules

RUN npx patchright install chromium \
  && mkdir -p /app/.orchestrator /ms-playwright /home/node/.npm-global /home/node/.npm \
  && chown -R node:node /app/.orchestrator /ms-playwright /home/node

# CAD runtime for the bundled skills/cad skill, plus python playwright for
# snapshot rendering (reuses system chromium via CAD_SNAPSHOT_CHROMIUM — no
# playwright-managed browser download, keeps ~400 MB off the eMMC).
#
# build123d comes from a pinned dev-branch commit, NOT PyPI: linux aarch64
# has OpenCascade wheels only for OCP 7.9 (cadquery-ocp[-novtk] 7.9.3+),
# which every stable build123d release (<=0.10) rejects (<7.9) — pip then
# backtracks to build123d 0.8.0, which crashes on OCP 7.9 (TopoDS_Shape
# .HashCode was removed in OCCT 7.9). The dev branch requires novtk>=7.9 and
# handles the aarch64 lib3mf split. Drop the pin for plain
# "/app/skills/cad/scripts/packages/cadpy" once build123d >=0.11 is on PyPI.
# Copy only that local package before installing it so ordinary app changes do
# not invalidate the large CAD dependency layer.
COPY --from=builder /app/skills/cad/scripts/packages/cadpy /tmp/cadpy
RUN pip3 install --break-system-packages --no-cache-dir \
    "build123d @ git+https://github.com/gumyr/build123d@dd35508482ed9e22352290a7366b4b36b0f37438" \
    /tmp/cadpy \
    playwright \
  && rm -rf /tmp/cadpy

# Changing application/build output comes after every heavyweight runtime
# dependency. /app/node_modules was removed in the builder stage, so this copy
# merges with (rather than duplicates) the stable dependency layer above.
COPY --from=builder --chown=node:node /app /app

# Build provenance changes on every release. Keep it at the very end so it no
# longer busts the apt, Python, Node, CAD, and Patchright caches.
ARG ORCHESTRATOR_BUILD_COMMIT=unknown
ARG ORCHESTRATOR_BUILD_REF=unknown
ENV ORCHESTRATOR_BUILD_COMMIT=${ORCHESTRATOR_BUILD_COMMIT} \
    ORCHESTRATOR_BUILD_REF=${ORCHESTRATOR_BUILD_REF}

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

USER node

EXPOSE 3000 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3000/api/ping >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
