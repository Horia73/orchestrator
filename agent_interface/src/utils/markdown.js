import { marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'highlight.js/styles/github-dark-dimmed.css';
import 'katex/dist/katex.min.css';

const CALLOUT_TYPES = {
  NOTE: { label: 'Note', icon: 'i', className: 'note' },
  WARNING: { label: 'Warning', icon: '!', className: 'warning' },
  TIP: { label: 'Tip', icon: '✓', className: 'tip' },
  IMPORTANT: { label: 'Important', icon: '•', className: 'important' },
  CAUTION: { label: 'Caution', icon: '!', className: 'caution' },
};

const mermaidState = {
  initialized: false,
  seq: 0,
  instance: null,
  loader: null,
};

async function getMermaidInstance() {
  if (mermaidState.instance) return mermaidState.instance;
  if (!mermaidState.loader) {
    mermaidState.loader = import('mermaid').then((module) => module.default || module);
  }

  mermaidState.instance = await mermaidState.loader;
  return mermaidState.instance;
}

async function ensureMermaidInitialized() {
  const mermaid = await getMermaidInstance();
  if (mermaidState.initialized) return mermaid;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      primaryColor: '#f5efe4',
      primaryTextColor: '#2d2b28',
      primaryBorderColor: '#c96442',
      lineColor: '#8e7c69',
      tertiaryColor: '#efe8db',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    },
  });
  mermaidState.initialized = true;
  return mermaid;
}

function escapeHtml(value) {
  const text = String(value ?? '');
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isDiffLanguage(lang) {
  const normalized = String(lang || '').toLowerCase();
  return normalized === 'diff' || normalized === 'patch';
}

function renderDiffCodeBlock(text) {
  const lines = String(text ?? '').split('\n');
  const renderedLines = lines
    .map((line) => {
      const safeLine = escapeHtml(line || ' ');
      let className = 'diff-line';

      if (line.startsWith('+') && !line.startsWith('+++')) {
        className += ' diff-line-added';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        className += ' diff-line-removed';
      } else if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
        className += ' diff-line-meta';
      }

      return `<span class="${className}">${safeLine}</span>`;
    })
    .join('\n');

  return `
    <div class="code-block-wrapper code-block-diff">
      <div class="code-block-header">
        <span class="code-block-lang">diff</span>
        <button class="code-copy-btn" data-code="${encodeURIComponent(text)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      </div>
      <pre><code class="hljs language-diff">${renderedLines}</code></pre>
    </div>
  `;
}

function renderMermaidBlock(text) {
  return `
    <div class="mermaid-block-wrapper">
      <div class="code-block-header">
        <span class="code-block-lang">mermaid</span>
        <button class="code-copy-btn" data-code="${encodeURIComponent(text)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      </div>
      <div class="mermaid-block" data-mermaid="${encodeURIComponent(text)}">
        <div class="mermaid-placeholder">Rendering diagram...</div>
      </div>
    </div>
  `;
}

function highlightCode(text, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang }).value;
    } catch {
      return escapeHtml(text);
    }
  }

  try {
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeHtml(text);
  }
}

function wrapTables(root) {
  root.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('markdown-table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table-wrap';
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

function decorateTaskLists(root) {
  root.querySelectorAll('li').forEach((item) => {
    const checkbox = item.querySelector(':scope > input[type="checkbox"]');
    if (!checkbox) return;

    item.classList.add('task-list-item');
    checkbox.classList.add('task-list-checkbox');
    checkbox.setAttribute('disabled', '');

    const list = item.parentElement;
    if (list && (list.tagName === 'UL' || list.tagName === 'OL')) {
      list.classList.add('task-list');
    }
  });
}

function decorateCallouts(root) {
  root.querySelectorAll('blockquote').forEach((blockquote) => {
    const firstParagraph = blockquote.querySelector(':scope > p:first-child');
    const sourceNode = firstParagraph || blockquote.firstChild;
    const sourceText = sourceNode?.textContent?.trim() || '';
    const match = sourceText.match(/^\[!([A-Z]+)\]\s*/);

    if (!match) return;

    const calloutType = CALLOUT_TYPES[match[1]] || {
      label: match[1],
      icon: '•',
      className: 'note',
    };

    blockquote.classList.add('markdown-callout', `markdown-callout-${calloutType.className}`);

    if (firstParagraph) {
      firstParagraph.textContent = firstParagraph.textContent.replace(/^\[![A-Z]+\]\s*/, '');
      if (!firstParagraph.textContent.trim()) {
        firstParagraph.remove();
      }
    } else if (sourceNode?.nodeType === Node.TEXT_NODE) {
      sourceNode.textContent = sourceNode.textContent.replace(/^\[![A-Z]+\]\s*/, '');
    }

    const title = document.createElement('div');
    title.className = 'markdown-callout-title';

    const icon = document.createElement('span');
    icon.className = 'markdown-callout-icon';
    icon.textContent = calloutType.icon;

    const label = document.createElement('span');
    label.className = 'markdown-callout-label';
    label.textContent = calloutType.label;

    title.appendChild(icon);
    title.appendChild(label);
    blockquote.prepend(title);
  });
}

function decorateCitationChips(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || '';
      if (!/\[(\d{1,3})\](?!:)/.test(value)) return NodeFilter.FILTER_REJECT;

      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('code, pre, a, .citation-chip, .katex')) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  nodes.forEach((textNode) => {
    const text = textNode.nodeValue || '';
    const regex = /\[(\d{1,3})\](?!:)/g;
    let lastIndex = 0;
    let match;
    let changed = false;

    const fragment = document.createDocumentFragment();

    while ((match = regex.exec(text)) !== null) {
      changed = true;
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const chip = document.createElement('span');
      chip.className = 'citation-chip';
      chip.dataset.citation = match[1];
      chip.textContent = `[${match[1]}]`;
      fragment.appendChild(chip);

      lastIndex = regex.lastIndex;
    }

    if (!changed) return;

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  });
}

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  const language = String(lang || 'text').toLowerCase();

  if (language === 'mermaid') {
    return renderMermaidBlock(text);
  }

  if (isDiffLanguage(language)) {
    return renderDiffCodeBlock(text);
  }

  const highlighted = highlightCode(text, lang);

  return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-block-lang">${escapeHtml(language || 'text')}</span>
        <button class="code-copy-btn" data-code="${encodeURIComponent(text)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      </div>
      <pre><code class="hljs language-${escapeHtml(language || 'text')}">${highlighted}</code></pre>
    </div>
  `;
};

const inlineKatexExtension = {
  name: 'inlineKatex',
  level: 'inline',
  start(src) {
    return src.indexOf('$');
  },
  tokenizer(src) {
    if (!src.startsWith('$') || src.startsWith('$$')) return undefined;
    const match = src.match(/^\$([^\n$]+?)\$/);
    if (!match) return undefined;
    return {
      type: 'inlineKatex',
      raw: match[0],
      text: match[1].trim(),
    };
  },
  renderer(token) {
    return `<span class="katex-inline">${katex.renderToString(token.text, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
    })}</span>`;
  },
};

const blockKatexExtension = {
  name: 'blockKatex',
  level: 'block',
  start(src) {
    return src.indexOf('$$');
  },
  tokenizer(src) {
    if (!src.startsWith('$$')) return undefined;
    const match = src.match(/^\$\$([\s\S]+?)\$\$(?:\n|$)/);
    if (!match) return undefined;
    return {
      type: 'blockKatex',
      raw: match[0],
      text: match[1].trim(),
    };
  },
  renderer(token) {
    return `<div class="katex-block">${katex.renderToString(token.text, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
    })}</div>`;
  },
};

marked.setOptions({
  breaks: true,
  gfm: true,
});

marked.use({
  renderer,
  extensions: [blockKatexExtension, inlineKatexExtension],
});

function postProcessHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;

  wrapTables(root);
  decorateTaskLists(root);
  decorateCallouts(root);
  decorateCitationChips(root);

  return template.innerHTML;
}

/**
 * Parse markdown to sanitized HTML.
 */
export function renderMarkdown(text) {
  const rawHtml = marked.parse(String(text || ''));
  const sanitized = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['data-code', 'data-mermaid', 'data-citation'],
  });
  return postProcessHtml(sanitized);
}

/**
 * Attach copy handlers to code blocks within a container.
 */
export function attachCopyHandlers(container) {
  container.querySelectorAll('.code-copy-btn').forEach((btn) => {
    if (btn.dataset.copyBound === '1') return;
    btn.dataset.copyBound = '1';

    btn.addEventListener('click', async () => {
      const code = decodeURIComponent(btn.dataset.code || '');
      try {
        await navigator.clipboard.writeText(code);
        const span = btn.querySelector('span');
        const original = span?.textContent || 'Copy';
        if (span) span.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          if (span) span.textContent = original;
          btn.classList.remove('copied');
        }, 1800);
      } catch (error) {
        console.error('Copy failed:', error);
      }
    });
  });
}

/**
 * Render Mermaid blocks in a container after markdown HTML is mounted.
 */
export function attachMermaidHandlers(container) {
  void ensureMermaidInitialized()
    .then((mermaid) => {
      container.querySelectorAll('.mermaid-block').forEach((block) => {
        if (block.dataset.mermaidRendered === '1') return;
        block.dataset.mermaidRendered = '1';

        const source = decodeURIComponent(block.dataset.mermaid || '');
        const id = `mermaid_${Date.now()}_${mermaidState.seq++}`;

        mermaid
          .render(id, source)
          .then(({ svg, bindFunctions }) => {
            block.innerHTML = svg;
            if (typeof bindFunctions === 'function') {
              bindFunctions(block);
            }
          })
          .catch((error) => {
            block.innerHTML = `<pre class="mermaid-error">${escapeHtml(error?.message || 'Failed to render Mermaid diagram.')}</pre>`;
          });
      });
    })
    .catch((error) => {
      console.error('Mermaid import failed:', error);
    });
}

/**
 * Convenience helper for all markdown-interaction hooks.
 */
export function attachMarkdownHandlers(container) {
  attachCopyHandlers(container);
  attachMermaidHandlers(container);
}
