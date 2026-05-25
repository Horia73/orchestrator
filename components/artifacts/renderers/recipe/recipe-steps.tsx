"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { interpolateScalableQuantities } from "@/lib/recipe/interpolate"
import type { RecipeArtifact, RecipeStep } from "@/lib/recipe/schema"

import { TimerChip } from "./timer-chip"

/**
 * Numbered step list. Each step renders:
 *   - circle index on the left
 *   - optional bold title
 *   - body as constrained inline markdown (bold/italic/links/lists; no
 *     headings — they'd visually collide with the title styling)
 *   - inline TimerChip at the end of the body when `timerSeconds` set
 *
 * Step 2 keeps timers inert; Step 4 swaps them for live countdowns.
 */
export function RecipeSteps({
    recipe,
    ratio = 1,
    className,
}: {
    recipe: RecipeArtifact
    /** Current scaling ratio from the servings stepper. Applied to any
     *  `{{N unit}}` tokens the model embedded in step titles or bodies. */
    ratio?: number
    className?: string
}) {
    return (
        <section className={cn("flex flex-col gap-3", className)} aria-labelledby="recipe-steps-heading">
            <h2
                id="recipe-steps-heading"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
                Pași
            </h2>
            <ol role="list" className="flex flex-col gap-4">
                {recipe.steps.map((step, idx) => (
                    <StepRow key={idx} index={idx + 1} step={step} ratio={ratio} />
                ))}
            </ol>
        </section>
    )
}

function StepRow({ index, step, ratio }: { index: number; step: RecipeStep; ratio: number }) {
    const interpolatedTitle = step.title ? interpolateScalableQuantities(step.title, ratio) : undefined
    const interpolatedBody = interpolateScalableQuantities(step.body, ratio)
    return (
        <li className="flex gap-3">
            <div
                aria-hidden
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium tabular-nums text-muted-foreground"
            >
                {index}
            </div>
            <div className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
                {interpolatedTitle ? (
                    <span className="mr-1.5 font-semibold">{interpolatedTitle}:</span>
                ) : null}
                <span className="recipe-step-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={STEP_MARKDOWN_COMPONENTS}>
                        {interpolatedBody}
                    </ReactMarkdown>
                </span>
                {step.timerSeconds !== undefined ? (
                    <>
                        {" "}
                        <TimerChip seconds={step.timerSeconds} label={step.title} />
                    </>
                ) : null}
            </div>
        </li>
    )
}

/**
 * Step body should read as inline prose. We collapse react-markdown's default
 * block elements into inline-friendly wrappers so a one-paragraph step
 * doesn't introduce stray block margins, while still letting the model emit
 * `**bold**`, `*italic*`, `[links](…)`, and short lists when truly needed.
 */
const STEP_MARKDOWN_COMPONENTS: Components = {
    p: ({ children }) => <span className="recipe-step-paragraph">{children}</span>,
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
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {children}
        </code>
    ),
    ul: ({ children }) => <ul className="mt-1 ml-5 list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="mt-1 ml-5 list-decimal space-y-0.5">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    // Headings inside a step would visually compete with the step title.
    // Render them as bold inline spans to keep the model's intent without
    // breaking the layout.
    h1: ({ children }) => <strong className="font-semibold">{children}</strong>,
    h2: ({ children }) => <strong className="font-semibold">{children}</strong>,
    h3: ({ children }) => <strong className="font-semibold">{children}</strong>,
    h4: ({ children }) => <strong className="font-semibold">{children}</strong>,
}
