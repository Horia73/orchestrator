"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import type { Options as RemarkMathOptions } from "remark-math"
import rehypeKatex from "rehype-katex"

import { cn } from "@/lib/utils"

/**
 * Markdown rendered as a standalone "document" inside an artifact surface.
 *
 * Distinct from {@link MarkdownRenderer} (the chat-prose renderer), which uses
 * bespoke per-element classes tuned for chat flow (including a chat-only
 * `md:-ml-16` gutter offset). Wrapping that renderer in `prose` would do
 * nothing because its inline classes win over the plugin's zero-specificity
 * `:where()` selectors.
 *
 * Here we hand react-markdown to Tailwind Typography directly so the body
 * looks like a typeset article — appropriate when the artifact is meant to be
 * read, saved, or printed as its own thing (recipes, explainers, briefs).
 *
 * Math (KaTeX) and GFM (tables, task lists, strikethrough) are supported. Math
 * loads its stylesheet lazily on first render of content that contains it, so
 * artifacts without math don't pay for the css.
 */

const remarkMathOptions: RemarkMathOptions = { singleDollarTextMath: false }

let katexCssLoaded = false
function ensureKatexCss(): void {
    if (katexCssLoaded || typeof document === "undefined") return
    katexCssLoaded = true
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"
    link.crossOrigin = "anonymous"
    document.head.appendChild(link)
}

const components: Components = {
    // Open external links in a new tab; let in-page anchors behave normally.
    a: ({ href, children }) => {
        const isExternal = typeof href === "string" && /^https?:\/\//i.test(href)
        return (
            <a
                href={href}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noopener noreferrer" : undefined}
            >
                {children}
            </a>
        )
    },
}

export function MarkdownArtifactRenderer({
    source,
    className,
}: {
    source: string
    className?: string
}) {
    React.useEffect(() => {
        if (source.includes("$") || source.includes("\\(") || source.includes("\\[")) {
            ensureKatexCss()
        }
    }, [source])

    return (
        <div
            className={cn(
                // Tailwind Typography baseline + dark mode inversion. `max-w-none`
                // because the artifact's parent already constrains width.
                "prose prose-neutral dark:prose-invert max-w-none",
                // Tighten the defaults a notch: prose ships with generous
                // article spacing that feels loose inside a chat bubble.
                "prose-sm md:prose-base",
                "prose-headings:font-semibold prose-headings:tracking-tight",
                "prose-h1:mt-0 prose-h1:mb-3",
                "prose-h2:mt-5 prose-h2:mb-2",
                "prose-h3:mt-4 prose-h3:mb-1.5",
                "prose-p:my-2 prose-p:leading-relaxed",
                "prose-li:my-0.5 prose-ul:my-2 prose-ol:my-2",
                "prose-blockquote:my-3 prose-blockquote:border-border prose-blockquote:not-italic prose-blockquote:text-muted-foreground",
                "prose-hr:my-4 prose-hr:border-border/60",
                // Code: subtle muted background instead of prose's default backtick chrome.
                "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none",
                "prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground",
                // Tables get a border treatment that matches the rest of the app.
                "prose-table:overflow-hidden prose-table:rounded-md prose-th:bg-muted/60",
                // Links pick up the app's primary color.
                "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
                // Images: round corners + cap height so a tall image doesn't take over.
                "prose-img:rounded-lg prose-img:my-3",
                "artifact-markdown",
                className,
            )}
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
                rehypePlugins={[rehypeKatex]}
                components={components}
            >
                {source}
            </ReactMarkdown>
        </div>
    )
}
