"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { parseRecipeArtifact } from "@/lib/recipe/parser"

import { RecipeActionBar } from "./recipe/recipe-action-bar"
import { RecipeErrorCard } from "./recipe/recipe-error-card"
import { RecipeHeader } from "./recipe/recipe-header"
import { RecipeImages } from "./recipe/recipe-images"
import { RecipeIngredients } from "./recipe/recipe-ingredients"
import { RecipeNotes } from "./recipe/recipe-notes"
import { RecipeSteps } from "./recipe/recipe-steps"

/**
 * Top-level renderer for `application/vnd.ant.recipe` artifacts.
 *
 * Like {@link WeatherRenderer}, this is a native React composition (not an
 * iframe sandbox) because the artifact body is pure structured data — there's
 * no untrusted HTML/JS to isolate. The component picks up the host app's
 * theme, fonts, and Tailwind tokens.
 *
 * Step 3 (this version): adds an interactive servings stepper above the
 * ingredients. The stepper drives a scaling `ratio = current/default` that
 * the ingredient list applies on the fly. Step 4 will activate the timer
 * chips. Step 5 will mount an image carousel above the header.
 *
 * Malformed JSON / schema violations render a styled error card — never a
 * silent blank artifact.
 */
export function RecipeRenderer({
    source,
    title,
    mode = "inline",
    className,
    artifactId,
}: {
    source: string
    title: string
    mode?: "inline" | "panel"
    className?: string
    /** Stable artifact row id — unused in Step 2, threaded for parity with
     *  WeatherRenderer/MapRenderer so future refresh affordances slot in. */
    artifactId?: string
}) {
    void mode
    void artifactId

    const parsed = React.useMemo(() => parseRecipeArtifact(source), [source])

    if (!parsed.ok) {
        return <RecipeErrorCard message={parsed.error} className={className} />
    }

    return <RecipeView recipe={parsed.value} title={title} className={className} />
}

/**
 * Inner view component. Split out from the top-level parser shell so the
 * `useState(default)` hook always sees a stable initial value even when the
 * caller swaps the artifact source. Re-mounted (and re-initialized) when the
 * recipe identity changes, via a `key` derived from the parsed shape.
 */
function RecipeView({
    recipe,
    title,
    className,
}: {
    recipe: import("@/lib/recipe/schema").RecipeArtifact
    title: string
    className?: string
}) {
    const [servings, setServings] = React.useState(recipe.servings.default)
    const ratio = servings / recipe.servings.default

    return (
        <article
            data-recipe
            className={cn(
                "flex w-full min-w-0 max-w-full flex-col gap-6 overflow-hidden text-foreground",
                className,
            )}
            aria-label={title || recipe.title}
        >
            <RecipeImages images={recipe.images} imageQuery={recipe.imageQuery} />
            <RecipeHeader recipe={recipe} />
            <RecipeActionBar
                servings={recipe.servings}
                value={servings}
                onChange={setServings}
                recipe={recipe}
            />
            <RecipeIngredients recipe={recipe} ratio={ratio} />
            <RecipeSteps recipe={recipe} ratio={ratio} />
            <RecipeNotes recipe={recipe} ratio={ratio} />
            {recipe.attribution ? (
                <footer className="text-xs text-muted-foreground">
                    Sursă: {recipe.attribution}
                </footer>
            ) : null}
        </article>
    )
}
