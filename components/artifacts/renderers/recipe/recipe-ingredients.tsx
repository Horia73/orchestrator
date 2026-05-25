"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { formatAmount, scaledIngredientAmount } from "@/lib/recipe/scale"
import type { RecipeArtifact, RecipeIngredient } from "@/lib/recipe/schema"

/**
 * Ingredient list. Groups consecutive ingredients sharing a `group` heading
 * under that heading (so a recipe with "Pentru sos: …" / "Pentru garnitură: …"
 * reads naturally), while ungrouped ingredients render under a default header.
 *
 * `ratio` scales every ingredient amount on the fly. Defaults to 1 — Step 2
 * always passes 1; the servings stepper added in Step 3 will drive it.
 */
export function RecipeIngredients({
    recipe,
    ratio = 1,
    className,
}: {
    recipe: RecipeArtifact
    ratio?: number
    className?: string
}) {
    const groups = React.useMemo(() => groupIngredients(recipe.ingredients), [recipe.ingredients])

    return (
        <section className={cn("flex flex-col gap-3", className)} aria-labelledby="recipe-ingredients-heading">
            <h2
                id="recipe-ingredients-heading"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
                Ingrediente
            </h2>
            {groups.map((group, gi) => (
                <div key={gi} className="flex flex-col gap-1.5">
                    {group.heading ? (
                        <h3 className="text-sm font-medium text-foreground">{group.heading}</h3>
                    ) : null}
                    <ul role="list" className="flex flex-col gap-1.5">
                        {group.items.map((ing, i) => (
                            <IngredientRow key={`${gi}-${i}`} ingredient={ing} ratio={ratio} />
                        ))}
                    </ul>
                </div>
            ))}
        </section>
    )
}

function IngredientRow({ ingredient, ratio }: { ingredient: RecipeIngredient; ratio: number }) {
    const scaled = scaledIngredientAmount(ingredient, ratio)
    const quantity = scaled === null ? null : `${formatAmount(scaled)}${ingredient.unit ? " " + formatUnit(ingredient.unit, scaled) : ""}`

    return (
        <li className="flex items-baseline gap-2 text-sm leading-relaxed text-foreground">
            {quantity ? (
                <span className="min-w-[5.5rem] shrink-0 font-medium tabular-nums">
                    {quantity}
                </span>
            ) : null}
            <span className={cn("min-w-0", !quantity && "pl-[5.5rem]")}>
                {ingredient.name}
                {ingredient.note ? (
                    <span className="ml-1 text-muted-foreground">({ingredient.note})</span>
                ) : null}
            </span>
        </li>
    )
}

/**
 * Pluralize Romanian/abbrev count units lightly. Pure cosmetic — the canonical
 * value remains the schema enum. We only switch between sing/plural for the
 * non-symbol units; "g", "kg", "ml", "tsp" stay as-is for any quantity.
 */
function formatUnit(unit: string, amount: number | null): string {
    const plural = (amount ?? 1) !== 1
    switch (unit) {
        case "catel": return plural ? "căței" : "cățel"
        case "catei": return "căței"
        case "felie": return plural ? "felii" : "felie"
        case "felii": return "felii"
        case "bucata": return plural ? "bucăți" : "bucată"
        case "buc": return "buc"
        case "priza": return plural ? "prize" : "priză"
        case "varf": return plural ? "vârfuri" : "vârf"
        case "cana": return plural ? "căni" : "cană"
        case "capac": return plural ? "capace" : "capac"
        default: return unit
    }
}

function groupIngredients(ingredients: RecipeIngredient[]): Array<{ heading?: string; items: RecipeIngredient[] }> {
    const out: Array<{ heading?: string; items: RecipeIngredient[] }> = []
    for (const ing of ingredients) {
        const last = out[out.length - 1]
        if (last && last.heading === ing.group) {
            last.items.push(ing)
        } else {
            out.push({ heading: ing.group, items: [ing] })
        }
    }
    return out
}
