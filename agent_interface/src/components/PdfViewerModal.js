import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_QUOTE_CHARS = 1800;
const MAX_SEARCH_RESULTS = 400;
const MIN_SCALE = 0.45;
const MAX_SCALE = 3.6;
const PROGRAMMATIC_SCROLL_LOCK_MS = 280;

export function createPdfViewerModal({ onQuote } = {}) {
  const root = document.createElement('div');
  root.className = 'pdf-viewer-overlay';

  root.innerHTML = `
    <div class="pdf-viewer-modal" role="dialog" aria-modal="true" aria-label="PDF viewer">
      <div class="pdf-viewer-header">
        <div class="pdf-viewer-title-wrap">
          <span class="pdf-viewer-title">PDF Viewer</span>
          <span class="pdf-viewer-file" id="pdf-viewer-file">document.pdf</span>
        </div>
        <button type="button" class="pdf-viewer-close" id="pdf-close-btn" aria-label="Close PDF viewer">✕</button>
      </div>

      <div class="pdf-viewer-toolbar">
        <div class="pdf-toolbar-group">
          <button type="button" class="pdf-toolbar-btn" id="pdf-prev-page">Prev</button>
          <button type="button" class="pdf-toolbar-btn" id="pdf-next-page">Next</button>
          <label class="pdf-page-label" for="pdf-page-input">Page</label>
          <input id="pdf-page-input" class="pdf-page-input" type="number" min="1" value="1" />
          <span class="pdf-page-total" id="pdf-page-total">/ 0</span>
        </div>

        <div class="pdf-toolbar-group">
          <button type="button" class="pdf-toolbar-btn" id="pdf-zoom-out">−</button>
          <span class="pdf-zoom-value" id="pdf-zoom-value">120%</span>
          <button type="button" class="pdf-toolbar-btn" id="pdf-zoom-in">+</button>
          <button type="button" class="pdf-toolbar-btn" id="pdf-fit-width">Fit</button>
        </div>

        <div class="pdf-toolbar-group pdf-search-group">
          <input id="pdf-search-input" class="pdf-search-input" type="search" placeholder="Search text" />
          <button type="button" class="pdf-toolbar-btn" id="pdf-search-run">Find</button>
          <button type="button" class="pdf-toolbar-btn" id="pdf-search-prev">↑</button>
          <button type="button" class="pdf-toolbar-btn" id="pdf-search-next">↓</button>
          <span class="pdf-search-count" id="pdf-search-count"></span>
        </div>

        <div class="pdf-toolbar-group">
          <button type="button" class="pdf-toolbar-btn" id="pdf-copy-text">Copy page text</button>
          <button type="button" class="pdf-toolbar-btn primary" id="pdf-quote-page">Quote page</button>
        </div>
      </div>

      <div class="pdf-viewer-content">
        <div class="pdf-canvas-pane" id="pdf-canvas-pane">
          <div class="pdf-canvas-wrap" id="pdf-canvas-wrap"></div>
        </div>
      </div>

      <div class="pdf-viewer-status" id="pdf-status"></div>
    </div>
  `;

  const closeBtn = root.querySelector('#pdf-close-btn');
  const fileLabel = root.querySelector('#pdf-viewer-file');
  const prevPageBtn = root.querySelector('#pdf-prev-page');
  const nextPageBtn = root.querySelector('#pdf-next-page');
  const pageInput = root.querySelector('#pdf-page-input');
  const pageTotal = root.querySelector('#pdf-page-total');
  const zoomOutBtn = root.querySelector('#pdf-zoom-out');
  const zoomInBtn = root.querySelector('#pdf-zoom-in');
  const fitBtn = root.querySelector('#pdf-fit-width');
  const zoomValue = root.querySelector('#pdf-zoom-value');
  const searchInput = root.querySelector('#pdf-search-input');
  const searchRunBtn = root.querySelector('#pdf-search-run');
  const searchPrevBtn = root.querySelector('#pdf-search-prev');
  const searchNextBtn = root.querySelector('#pdf-search-next');
  const searchCount = root.querySelector('#pdf-search-count');
  const copyTextBtn = root.querySelector('#pdf-copy-text');
  const quotePageBtn = root.querySelector('#pdf-quote-page');
  const canvasPane = root.querySelector('#pdf-canvas-pane');
  const canvasWrap = root.querySelector('#pdf-canvas-wrap');
  const status = root.querySelector('#pdf-status');

  let pdfDocument = null;
  let loadingTask = null;
  const activeRenderTasks = new Set();

  let currentPage = 1;
  let totalPages = 0;
  let scale = 1.2;

  let currentFileName = 'document.pdf';
  let currentFileUrl = '';

  let searchQuery = '';
  let searchResults = [];
  let searchCursor = -1;

  const pageTextCache = new Map();
  const renderedPages = new Set();
  const pageShells = new Map();
  const pageCanvases = new Map();

  let openVersion = 0;
  let renderCycle = 0;
  let scrollFrame = null;
  let scrollLockTimer = null;
  let isProgrammaticScroll = false;

  function isOpen() {
    return root.classList.contains('open');
  }

  function setStatus(message, tone = 'default') {
    status.textContent = message || '';
    status.dataset.tone = tone;
  }

  function setControlsDisabled(disabled) {
    [
      prevPageBtn,
      nextPageBtn,
      pageInput,
      zoomOutBtn,
      zoomInBtn,
      fitBtn,
      searchInput,
      searchRunBtn,
      searchPrevBtn,
      searchNextBtn,
      copyTextBtn,
      quotePageBtn,
    ].forEach((control) => {
      control.disabled = Boolean(disabled);
    });
  }

  function updateControls() {
    const hasDocument = Boolean(pdfDocument);

    pageInput.min = '1';
    pageInput.max = String(Math.max(totalPages, 1));
    pageInput.value = String(Math.max(currentPage, 1));
    pageTotal.textContent = `/ ${Math.max(totalPages, 0)}`;
    zoomValue.textContent = `${Math.round(scale * 100)}%`;

    prevPageBtn.disabled = !hasDocument || currentPage <= 1;
    nextPageBtn.disabled = !hasDocument || currentPage >= totalPages;

    const hasMatches = searchResults.length > 0;
    searchPrevBtn.disabled = !hasMatches;
    searchNextBtn.disabled = !hasMatches;
    searchCount.textContent = hasMatches ? `${searchCursor + 1}/${searchResults.length}` : (searchQuery ? '0/0' : '');

    copyTextBtn.disabled = !hasDocument;
    quotePageBtn.disabled = !hasDocument;
  }

  function flashButtonText(button, nextLabel) {
    const label = button.textContent;
    button.textContent = nextLabel;
    button.classList.add('is-flashed');
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove('is-flashed');
    }, 1200);
  }

  function close() {
    root.classList.remove('open');
  }

  function resetSearch() {
    searchQuery = '';
    searchResults = [];
    searchCursor = -1;
    searchInput.value = '';
  }

  function cancelRenderTasks() {
    for (const task of activeRenderTasks) {
      try {
        task.cancel();
      } catch {
        // no-op
      }
    }
    activeRenderTasks.clear();
  }

  function clearRenderedPages() {
    renderedPages.clear();
    pageShells.clear();
    pageCanvases.clear();
    canvasWrap.innerHTML = '';
  }

  async function clearPdfState() {
    renderCycle += 1;
    cancelRenderTasks();
    clearRenderedPages();
    if (scrollFrame) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    if (scrollLockTimer) {
      clearTimeout(scrollLockTimer);
      scrollLockTimer = null;
    }
    isProgrammaticScroll = false;

    if (loadingTask) {
      try {
        loadingTask.destroy();
      } catch {
        // no-op
      }
      loadingTask = null;
    }

    if (pdfDocument) {
      try {
        await pdfDocument.destroy();
      } catch {
        // no-op
      }
      pdfDocument = null;
    }
  }

  function buildPageShells({ placeholderWidth = 1, placeholderHeight = 1 } = {}) {
    clearRenderedPages();
    const fragment = document.createDocumentFragment();
    const width = Math.max(1, Math.floor(placeholderWidth));
    const height = Math.max(1, Math.floor(placeholderHeight));

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const shell = document.createElement('section');
      shell.className = 'pdf-page-shell';
      shell.dataset.page = String(pageNumber);

      const pageBadge = document.createElement('div');
      pageBadge.className = 'pdf-page-badge';
      pageBadge.textContent = `Page ${pageNumber}`;
      shell.appendChild(pageBadge);

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      shell.appendChild(canvas);

      pageShells.set(pageNumber, shell);
      pageCanvases.set(pageNumber, canvas);
      fragment.appendChild(shell);
    }

    canvasWrap.appendChild(fragment);
  }

  function lockProgrammaticScroll(durationMs, action) {
    if (scrollLockTimer) {
      clearTimeout(scrollLockTimer);
      scrollLockTimer = null;
    }

    isProgrammaticScroll = true;
    action();

    scrollLockTimer = setTimeout(() => {
      isProgrammaticScroll = false;
      syncCurrentPageFromScroll();
    }, durationMs);
  }

  function getClosestPageInView() {
    if (totalPages < 1) return 1;

    const viewportCenter = canvasPane.scrollTop + canvasPane.clientHeight / 2;
    let closestPage = currentPage;
    let smallestDistance = Number.POSITIVE_INFINITY;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const shell = pageShells.get(pageNumber);
      if (!shell) continue;

      const center = shell.offsetTop + shell.offsetHeight / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        closestPage = pageNumber;
      }
    }

    return closestPage;
  }

  function syncCurrentPageFromScroll() {
    if (!pdfDocument || isProgrammaticScroll) return;
    const nextPage = getClosestPageInView();

    if (nextPage === currentPage) return;
    currentPage = nextPage;
    updateControls();
    setStatus(`Page ${currentPage} of ${totalPages}`, 'default');
  }

  function scheduleScrollSync() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      syncCurrentPageFromScroll();
    });
  }

  async function getPageText(pageNumber) {
    if (!pdfDocument) return '';
    if (pageTextCache.has(pageNumber)) {
      return pageTextCache.get(pageNumber) || '';
    }

    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pageTextCache.set(pageNumber, text);
    return text;
  }

  async function renderPage(pageNumber, cycleId) {
    if (!pdfDocument || cycleId !== renderCycle) return false;
    if (renderedPages.has(pageNumber)) return true;

    const page = await pdfDocument.getPage(pageNumber);
    if (!pdfDocument || cycleId !== renderCycle) return false;

    const canvas = pageCanvases.get(pageNumber);
    if (!canvas) return false;

    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const renderTask = page.render({ canvasContext: context, viewport });
    activeRenderTasks.add(renderTask);

    try {
      await renderTask.promise;
      if (!pdfDocument || cycleId !== renderCycle) return false;
      renderedPages.add(pageNumber);
      return true;
    } catch (error) {
      if (!isRenderCancelled(error)) {
        console.error(`Failed to render PDF page ${pageNumber}:`, error);
      }
      return false;
    } finally {
      activeRenderTasks.delete(renderTask);
    }
  }

  function buildRenderOrder(priorityPage) {
    const order = [];

    if (priorityPage >= 1 && priorityPage <= totalPages) {
      order.push(priorityPage);
    }

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (pageNumber !== priorityPage) {
        order.push(pageNumber);
      }
    }

    return order;
  }

  async function renderPagesInBackground(priorityPage, cycleId) {
    const renderOrder = buildRenderOrder(priorityPage);

    for (const pageNumber of renderOrder) {
      if (!pdfDocument || cycleId !== renderCycle) return;
      if (renderedPages.has(pageNumber)) continue;
      await renderPage(pageNumber, cycleId);
    }
  }

  function scrollToPage(pageNumber, behavior = 'smooth') {
    const shell = pageShells.get(pageNumber);
    if (!shell) return;

    lockProgrammaticScroll(
      behavior === 'smooth' ? PROGRAMMATIC_SCROLL_LOCK_MS : 80,
      () => {
        shell.scrollIntoView({
          block: 'start',
          inline: 'nearest',
          behavior,
        });
      }
    );
  }

  async function rerenderAllPages(priorityPage = currentPage) {
    if (!pdfDocument) return;

    cancelRenderTasks();
    renderedPages.clear();
    renderCycle += 1;
    const cycleId = renderCycle;

    await renderPage(priorityPage, cycleId);
    if (!pdfDocument || cycleId !== renderCycle) return;

    scrollToPage(priorityPage, 'auto');
    updateControls();
    setStatus(`Page ${currentPage} of ${totalPages}`, 'default');
    void renderPagesInBackground(priorityPage, cycleId);
  }

  async function goToPage(pageNumber, { behavior = 'smooth' } = {}) {
    if (!pdfDocument) return;
    const nextPage = Math.max(1, Math.min(totalPages, Number(pageNumber) || 1));
    if (nextPage !== currentPage) {
      currentPage = nextPage;
    }

    await renderPage(nextPage, renderCycle);
    if (!pdfDocument) return;

    scrollToPage(nextPage, behavior);
    updateControls();
    setStatus(`Page ${currentPage} of ${totalPages}`, 'default');
  }

  async function runSearch() {
    if (!pdfDocument) return;

    const nextQuery = searchInput.value.trim();
    if (!nextQuery) {
      resetSearch();
      updateControls();
      setStatus('Search cleared.', 'default');
      return;
    }

    if (nextQuery === searchQuery && searchResults.length > 0) {
      await jumpSearch(1);
      return;
    }

    searchQuery = nextQuery;
    searchResults = await collectMatches(nextQuery);

    if (searchResults.length === 0) {
      searchCursor = -1;
      updateControls();
      setStatus(`No matches for "${nextQuery}".`, 'warning');
      return;
    }

    const nearestIndex = searchResults.findIndex((result) => result.page >= currentPage);
    searchCursor = nearestIndex >= 0 ? nearestIndex : 0;

    await goToPage(searchResults[searchCursor].page);
    setStatus(`Found ${searchResults.length} matches for "${nextQuery}".`, 'success');
    updateControls();
  }

  async function jumpSearch(direction) {
    if (!pdfDocument) return;
    if (searchResults.length === 0) {
      await runSearch();
      return;
    }

    const length = searchResults.length;
    searchCursor = (searchCursor + direction + length) % length;
    const result = searchResults[searchCursor];

    await goToPage(result.page);
    setStatus(`Match ${searchCursor + 1} of ${length}`, 'default');
    updateControls();
  }

  async function collectMatches(query) {
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) return [];

    const matches = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const text = await getPageText(pageNumber);
      if (!text) continue;

      const normalizedText = text.toLowerCase();
      let cursor = 0;

      while (cursor < normalizedText.length) {
        const index = normalizedText.indexOf(normalizedQuery, cursor);
        if (index === -1) break;

        matches.push({
          page: pageNumber,
          index,
        });

        if (matches.length >= MAX_SEARCH_RESULTS) {
          return matches;
        }

        cursor = index + Math.max(1, normalizedQuery.length);
      }
    }

    return matches;
  }

  async function copyCurrentPageText() {
    if (!pdfDocument) return;

    const pageText = await getPageText(currentPage);
    if (!pageText) {
      setStatus('Nothing to copy on this page.', 'warning');
      return;
    }

    try {
      await navigator.clipboard.writeText(pageText);
      flashButtonText(copyTextBtn, 'Copied');
      setStatus('Page text copied to clipboard.', 'success');
    } catch (error) {
      console.error('Failed to copy PDF text:', error);
      setStatus('Clipboard copy failed.', 'error');
    }
  }

  async function quoteCurrentPage() {
    if (!pdfDocument || typeof onQuote !== 'function') return;

    const rawText = await getPageText(currentPage);
    const compact = rawText.replace(/\s+/g, ' ').trim();
    const snippet = compact.slice(0, MAX_QUOTE_CHARS);
    const suffix = compact.length > MAX_QUOTE_CHARS ? '…' : '';

    const quoteText = compact
      ? `[PDF quote: ${currentFileName}, page ${currentPage}]\n${snippet}${suffix}`
      : `[PDF quote: ${currentFileName}, page ${currentPage}]`;

    onQuote({
      text: quoteText,
      page: currentPage,
      fileName: currentFileName,
      url: currentFileUrl,
    });

    flashButtonText(quotePageBtn, 'Quoted');
    setStatus(`Quoted page ${currentPage} into draft.`, 'success');
  }

  async function adjustZoom(delta) {
    if (!pdfDocument) return;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta));
    if (Math.abs(nextScale - scale) < 0.001) return;

    scale = nextScale;
    await rerenderAllPages(currentPage);
  }

  async function fitToWidth() {
    if (!pdfDocument) return;

    const page = await pdfDocument.getPage(currentPage);
    const baseViewport = page.getViewport({ scale: 1 });
    const available = Math.max(280, canvasPane.clientWidth - 36);

    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / baseViewport.width));
    await rerenderAllPages(currentPage);
  }

  async function open({ url, name }) {
    if (!url) return;

    const thisOpen = ++openVersion;

    root.classList.add('open');
    currentFileName = name || 'document.pdf';
    currentFileUrl = url;
    fileLabel.textContent = currentFileName;

    currentPage = 1;
    totalPages = 0;
    scale = 1.2;
    pageTextCache.clear();
    resetSearch();

    setStatus('Loading PDF...', 'default');
    setControlsDisabled(true);
    updateControls();

    await clearPdfState();

    try {
      loadingTask = getDocument({
        url,
        isEvalSupported: false,
        useSystemFonts: true,
      });

      const loadedDocument = await loadingTask.promise;
      if (thisOpen !== openVersion) {
        await loadedDocument.destroy();
        return;
      }

      pdfDocument = loadedDocument;
      totalPages = loadedDocument.numPages;
      currentPage = 1;

      const firstPage = await loadedDocument.getPage(1);
      const firstViewport = firstPage.getViewport({ scale });
      buildPageShells({
        placeholderWidth: firstViewport.width,
        placeholderHeight: firstViewport.height,
      });

      lockProgrammaticScroll(80, () => {
        canvasPane.scrollTop = 0;
        canvasPane.scrollLeft = 0;
      });

      renderCycle += 1;
      const cycleId = renderCycle;

      setControlsDisabled(false);
      updateControls();

      await renderPage(1, cycleId);
      if (!pdfDocument || thisOpen !== openVersion || cycleId !== renderCycle) return;

      lockProgrammaticScroll(80, () => {
        canvasPane.scrollTop = 0;
      });

      updateControls();
      setStatus(`Loaded ${currentFileName}. Scroll to browse all ${totalPages} pages.`, 'success');

      void renderPagesInBackground(1, cycleId);
    } catch (error) {
      console.error('PDF load failed:', error);
      setStatus('Failed to open PDF.', 'error');
      setControlsDisabled(false);
      updateControls();
    }
  }

  closeBtn.addEventListener('click', () => close());

  root.addEventListener('click', (event) => {
    if (event.target === root) {
      close();
    }
  });

  canvasPane.addEventListener('scroll', scheduleScrollSync);

  prevPageBtn.addEventListener('click', () => {
    void goToPage(currentPage - 1);
  });

  nextPageBtn.addEventListener('click', () => {
    void goToPage(currentPage + 1);
  });

  pageInput.addEventListener('change', () => {
    void goToPage(pageInput.value);
  });

  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void goToPage(pageInput.value);
    }
  });

  zoomOutBtn.addEventListener('click', () => {
    void adjustZoom(-0.15);
  });

  zoomInBtn.addEventListener('click', () => {
    void adjustZoom(0.15);
  });

  fitBtn.addEventListener('click', () => {
    void fitToWidth();
  });

  searchRunBtn.addEventListener('click', () => {
    void runSearch();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    }
  });

  searchPrevBtn.addEventListener('click', () => {
    void jumpSearch(-1);
  });

  searchNextBtn.addEventListener('click', () => {
    void jumpSearch(1);
  });

  copyTextBtn.addEventListener('click', () => {
    void copyCurrentPageText();
  });

  quotePageBtn.addEventListener('click', () => {
    void quoteCurrentPage();
  });

  document.addEventListener('keydown', (event) => {
    if (!isOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (isEditableTarget(event.target)) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void goToPage(currentPage - 1);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      void goToPage(currentPage + 1);
    }
  });

  updateControls();

  return {
    element: root,
    open,
    close,
  };
}

function isRenderCancelled(error) {
  return Boolean(error && (
    error.name === 'RenderingCancelledException'
    || error.name === 'AbortException'
    || /cancel/i.test(String(error.message || ''))
  ));
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;

  if (target.isContentEditable) return true;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
