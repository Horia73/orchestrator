"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { interpolateScalableQuantities } from "@/lib/recipe/interpolate"
import type { RecipeArtifact } from "@/lib/recipe/schema"

/**
 * Notes / tips & variations section. Rendered as a subtle card at the bottom
 * of the recipe with one or more bullet groups. Mirrors the "NOTES" block in
 * the claude.ai reference screenshot.
 */
export function RecipeNotes({
    recipe,
    ratio = 1,
    className,
}: {
    recipe: RecipeArtifact
    /** Current scaling ratio; applied to any `{{N unit}}` tokens in bullets
     *  so a note like "{{120 ml}} apă" follows the stepper. */
    ratio?: number
    className?: string
}) {
    if (!recipe.notes?.length) return null

    return (
        <section
            className={cn(
                "rounded-lg border border-border bg-muted/40 px-4 py-3",
                "flex flex-col gap-3",
                className,
            )}
            aria-labelledby="recipe-notes-heading"
        >
            <h2
                id="recipe-notes-heading"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
                Notițe
            </h2>
            {recipe.notes.map((block, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                    {block.heading ? (
                        <h3 className="text-sm font-semibold text-foreground">{block.heading}</h3>
                    ) : null}
                    <ul role="list" className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-foreground">
                        {block.bullets.map((bullet, j) => (
                            <li key={j}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={NOTE_MARKDOWN_COMPONENTS}>
                                    {interpolateScalableQuantities(bullet, ratio)}
                                </ReactMarkdown>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </section>
    )
}

const NOTE_MARKDOWN_COMPONENTS: Components = {
    p: ({ children }) => <span>{children}</span>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ href, children }) => (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline"
        >
            {children}
        </a>
    ),
    code: ({ children }) => (
        <code className="rounded bg-background px-1 py-0.5 font-mono text-[0.85em]">
            {children}
        </code>
    ),
}
