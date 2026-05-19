"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import type { Options as RemarkMathOptions } from "remark-math"
import rehypeKatex from "rehype-katex"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import type { Components } from "react-markdown"

// ---------------------------------------------------------------------------
// KaTeX CSS (loaded once)
// ---------------------------------------------------------------------------

let katexCssLoaded = false
function ensureKatexCss() {
  if (katexCssLoaded || typeof document === "undefined") return
  katexCssLoaded = true
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"
  link.crossOrigin = "anonymous"
  document.head.appendChild(link)
}

// ---------------------------------------------------------------------------
// Highlighted code block (async shiki → cached HTML)
// ---------------------------------------------------------------------------

const highlightCache = new Map<string, string>()
const remarkMathOptions: RemarkMathOptions = { singleDollarTextMath: false }

function HighlightedCode({
  code,
  language,
}: {
  code: string
  language: string
}) {
  const [html, setHtml] = React.useState<string | null>(() => {
    const key = `${language}:${code}`
    return highlightCache.get(key) ?? null
  })

  React.useEffect(() => {
    const key = `${language}:${code}`
    if (highlightCache.has(key)) {
      setHtml(highlightCache.get(key)!)
      return
    }

    let cancelled = false
    import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: language,
          theme: "github-light",
        })
      )
      .then((result) => {
        if (cancelled) return
        highlightCache.set(key, result)
        setHtml(result)
      })
      .catch(() => {
        if (!cancelled) setHtml("")
      })

    return () => {
      cancelled = true
    }
  }, [code, language])

  if (html === null || html === "") {
    return (
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed [&_code]:!bg-transparent [&_code]:!font-mono [&_code]:!text-[13px] [&_code]:!leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ---------------------------------------------------------------------------
// Code block wrapper with copy button
// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)

  const handleCopy = React.useCallback(async () => {
    if (!(await copyTextToClipboard(code))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [code])

  return (
    <div
      className="relative my-3 overflow-hidden rounded-xl border border-border/50 bg-white dark:bg-muted/15"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {language && (
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {language}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          "absolute top-1.5 right-2 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground",
          hovered ? "opacity-100" : "opacity-0"
        )}
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      <HighlightedCode code={code} language={language || "text"} />
    </div>
  )
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [failed, setFailed] = React.useState(false)
  const imageSrc = typeof src === "string" ? src : undefined
  const isWhatsAppQr =
    typeof imageSrc === "string" &&
    imageSrc.includes("/api/integrations/whatsapp/qr")

  if (!imageSrc) return null
  if (failed) {
    return (
      <span className="my-2 inline-flex rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[12px] text-muted-foreground">
        {isWhatsAppQr ? "WhatsApp QR expired" : alt || "Image unavailable"}
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageSrc}
      alt={alt || ""}
      className="my-2 max-w-full rounded-lg"
      onError={() => setFailed(true)}
    />
  )
}

// ---------------------------------------------------------------------------
// Custom react-markdown components
// ---------------------------------------------------------------------------

const baseComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-[22px] font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-[18px] font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[16px] font-semibold">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 text-[15px] font-semibold">{children}</h4>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => (
    <del className="text-muted-foreground">{children}</del>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const match = /language-(\w+)/.exec(className || "")
    const language = match ? match[1] : ""
    const code = String(children).replace(/\n$/, "")

    if (match) {
      return <CodeBlock language={language} code={code} />
    }

    // Inline code
    return (
      <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]">
        {children}
      </code>
    )
  },
  pre: ({ children }) => {
    const child = React.Children.only(children) as React.ReactElement<{
      className?: string
    }>
    if (child?.props?.className && /language-/.test(child.props.className)) {
      return <>{children}</>
    }
    const code = String(
      (child as React.ReactElement<{ children?: React.ReactNode }>)?.props
        ?.children ?? ""
    ).replace(/\n$/, "")
    return <CodeBlock language="" code={code} />
  },
  hr: () => <hr className="my-4 border-t border-border/60" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-[14px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border/40 bg-muted/40">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-border/30">{children}</tbody>
  ),
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-[13px] font-semibold text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2">{children}</td>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
}

const contextComponents: Components = {
  ...baseComponents,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-6 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2 list-decimal space-y-1 pl-6 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6"
    >
      {children}
    </ol>
  ),
  li: ({ children, node }) => {
    const firstChild = node?.children?.[0]
    const isTaskItem =
      firstChild &&
      firstChild.type === "element" &&
      firstChild.tagName === "input" &&
      (firstChild.properties as Record<string, unknown>)?.type === "checkbox"

    if (isTaskItem) {
      const checked = !!(firstChild.properties as Record<string, unknown>)
        ?.checked
      return (
        <li className="flex items-start gap-2">
          <span
            className={cn(
              "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded border text-[11px]",
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background"
            )}
          >
            {checked && <Check className="size-3" strokeWidth={3} />}
          </span>
          <div className="min-w-0">
            {React.Children.toArray(children).slice(1)}
          </div>
        </li>
      )
    }

    return <li className="leading-relaxed">{children}</li>
  },
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content,
}: {
  content: string
}) {
  React.useEffect(() => {
    if (
      content.includes("$") ||
      content.includes("\\(") ||
      content.includes("\\[")
    ) {
      ensureKatexCss()
    }
  }, [content])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
      rehypePlugins={[rehypeKatex]}
      components={contextComponents}
    >
      {content}
    </ReactMarkdown>
  )
})
