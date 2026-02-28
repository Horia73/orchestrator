import {
    Children,
    cloneElement,
    isValidElement,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import diff from 'highlight.js/lib/languages/diff';
import 'highlight.js/styles/github-dark-dimmed.css';
import 'katex/dist/katex.min.css';
import { IconCheck, IconCopy } from '../shared/icons.jsx';

const CALLOUT_TYPES = {
    NOTE: { label: 'Note', className: 'note' },
    WARNING: { label: 'Warning', className: 'warning' },
    TIP: { label: 'Tip', className: 'tip' },
    IMPORTANT: { label: 'Important', className: 'important' },
    CAUTION: { label: 'Caution', className: 'caution' },
};

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c++', cpp);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('php', php);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('patch', diff);

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

function toPlainText(children) {
    if (typeof children === 'string') return children;
    if (Array.isArray(children)) {
        return children.map(toPlainText).join('');
    }
    if (children && typeof children === 'object' && 'props' in children) {
        return toPlainText(children.props.children);
    }
    return '';
}

function isDiffLanguage(language) {
    return language === 'diff' || language === 'patch';
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

function highlightCode(text, language) {
    if (language && hljs.getLanguage(language)) {
        try {
            return hljs.highlight(text, { language }).value;
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

function renderDiffCode(text) {
    return String(text ?? '')
        .split('\n')
        .map((line) => {
            const safeLine = escapeHtml(line || ' ');
            let className = 'diff-line';

            if (line.startsWith('+') && !line.startsWith('+++')) {
                className += ' diff-line-added';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                className += ' diff-line-removed';
            } else if (
                line.startsWith('@@') ||
                line.startsWith('diff ') ||
                line.startsWith('index ')
            ) {
                className += ' diff-line-meta';
            }

            return `<span class="${className}">${safeLine}</span>`;
        })
        .join('\n');
}

function getCalloutConfig(rawType) {
    const key = String(rawType || '').toUpperCase();
    return CALLOUT_TYPES[key] || {
        label: key || 'Note',
        className: 'note',
    };
}

function parseCallout(children) {
    const blocks = Children.toArray(children);
    const firstBlock = blocks[0];
    if (!isValidElement(firstBlock) || firstBlock.type !== 'p') return null;

    const paragraphChildren = Children.toArray(firstBlock.props.children);
    if (!paragraphChildren.length || typeof paragraphChildren[0] !== 'string') {
        return null;
    }

    const head = paragraphChildren[0];
    const match = head.match(/^\[!([a-zA-Z]+)\]\s*/);
    if (!match) return null;

    const callout = getCalloutConfig(match[1]);
    const updatedHead = head.replace(/^\[![a-zA-Z]+\]\s*/, '');
    const nextParagraphChildren = [updatedHead, ...paragraphChildren.slice(1)];
    const hasParagraphText = nextParagraphChildren
        .map((part) => (typeof part === 'string' ? part : toPlainText(part)))
        .join('')
        .trim().length > 0;

    const nextBlocks = hasParagraphText
        ? [cloneElement(firstBlock, firstBlock.props, ...nextParagraphChildren), ...blocks.slice(1)]
        : blocks.slice(1);

    return { callout, children: nextBlocks };
}

function MermaidBlock({ code }) {
    const [result, setResult] = useState({
        code: '',
        svg: '',
        error: '',
    });

    useEffect(() => {
        let mounted = true;

        void ensureMermaidInitialized()
            .then((mermaid) => {
                const id = `mermaid_${Date.now()}_${mermaidState.seq++}`;
                return mermaid.render(id, code);
            })
            .then(({ svg: renderedSvg }) => {
                if (!mounted) return;
                setResult({
                    code,
                    svg: renderedSvg,
                    error: '',
                });
            })
            .catch((renderError) => {
                if (!mounted) return;
                setResult({
                    code,
                    svg: '',
                    error: renderError?.message || 'Failed to render Mermaid diagram.',
                });
            });

        return () => {
            mounted = false;
        };
    }, [code]);

    if (result.code !== code) {
        return <div className="mermaid-placeholder">Rendering diagram...</div>;
    }

    if (result.error) {
        return <pre className="mermaid-error">{result.error}</pre>;
    }

    if (!result.svg) {
        return <div className="mermaid-placeholder">Rendering diagram...</div>;
    }

    return (
        <div
            className="mermaid-svg-wrap"
            dangerouslySetInnerHTML={{ __html: result.svg }}
        />
    );
}

function CodeBlock({ className, children }) {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef(null);

    const language = useMemo(() => {
        const match = /language-([a-zA-Z0-9_+-]+)/.exec(className ?? '');
        return (match?.[1] ?? 'text').toLowerCase();
    }, [className]);

    const codeText = useMemo(
        () => toPlainText(children).replace(/\n$/, ''),
        [children],
    );

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const handleCopy = useCallback(async () => {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(codeText);
            } else {
                const fallback = document.createElement('textarea');
                fallback.value = codeText;
                fallback.setAttribute('readonly', '');
                fallback.style.position = 'fixed';
                fallback.style.opacity = '0';
                document.body.appendChild(fallback);
                fallback.select();
                document.execCommand('copy');
                document.body.removeChild(fallback);
            }

            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 1600);
        } catch {
            setCopied(false);
        }
    }, [codeText]);

    const highlightedCode = useMemo(
        () => highlightCode(codeText, language),
        [codeText, language],
    );

    const diffCode = useMemo(
        () => renderDiffCode(codeText),
        [codeText],
    );

    const isMermaid = language === 'mermaid';
    const isDiff = isDiffLanguage(language);

    return (
        <div className={`code-block${isDiff ? ' diff-block' : ''}`}>
            <div className="code-block-toolbar">
                <span className="code-language">{language || 'text'}</span>
                <button
                    type="button"
                    className={`code-copy-btn${copied ? ' copied' : ''}`}
                    onClick={handleCopy}
                    aria-label={copied ? 'Code copied' : 'Copy code'}
                >
                    {copied ? <IconCheck /> : <IconCopy />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
            </div>
            {isMermaid ? (
                <div className="mermaid-block">
                    <MermaidBlock code={codeText} />
                </div>
            ) : (
                <pre className="code-pre">
                    <code
                        className={`hljs language-${language || 'text'}`}
                        dangerouslySetInnerHTML={{
                            __html: isDiff ? diffCode : highlightedCode,
                        }}
                    />
                </pre>
            )}
        </div>
    );
}

export function MarkdownContent({ text, variant = 'ai' }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const contentRef = useRef(null);

    const components = useMemo(
        () => ({
            table({ children }) {
                return (
                    <div className="table-wrap">
                        <table>{children}</table>
                    </div>
                );
            },
            code({ inline, className, children }) {
                if (inline) {
                    return <code className="inline-code">{children}</code>;
                }
                return <CodeBlock className={className}>{children}</CodeBlock>;
            },
            a({ href, children, ...props }) {
                return (
                    <a href={href} target="_blank" rel="noreferrer" {...props}>
                        {children}
                    </a>
                );
            },
            img() {
                return null;
            },
            blockquote({ children }) {
                const parsed = parseCallout(children);
                if (!parsed) return <blockquote>{children}</blockquote>;

                return (
                    <blockquote className={`markdown-callout markdown-callout-${parsed.callout.className}`}>
                        <div className="markdown-callout-title">{parsed.callout.label}</div>
                        {parsed.children}
                    </blockquote>
                );
            },
        }),
        [],
    );

    useLayoutEffect(() => {
        if (variant !== 'user') return;
        const el = contentRef.current;
        if (!el) return;

        const observer = new ResizeObserver(() => {
            const shouldOverflow = el.scrollHeight > 480;
            setIsOverflowing(shouldOverflow);
            if (!shouldOverflow && isExpanded) {
                setIsExpanded(false);
            }
        });

        observer.observe(el);
        return () => observer.disconnect();
    }, [isExpanded, variant, text]);

    const content = (
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={components}
        >
            {text ?? ''}
        </ReactMarkdown>
    );

    if (variant === 'ai') {
        return <div className="message-markdown ai">{content}</div>;
    }

    return (
        <div className={`message-markdown user${isOverflowing && !isExpanded ? ' clamped' : ''}`}>
            <div ref={contentRef} className="markdown-inner">
                {content}
            </div>
            {isOverflowing && (
                <div className="markdown-expand-overlay">
                    <button
                        type="button"
                        className="markdown-expand-btn"
                        onClick={() => setIsExpanded(p => !p)}
                    >
                        {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                </div>
            )}
        </div>
    );
}
