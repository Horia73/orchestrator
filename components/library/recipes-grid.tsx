"use client"

import * as React from "react"
import Link from "next/link"
import { ChefHat, Clock, Flame, Users } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatRelativeTime } from "./use-attachments"
import type { LibraryRecipeRow } from "@/app/api/library/recipes/route"

const DIFFICULTY_LABEL: Record<NonNullable<LibraryRecipeRow['difficulty']>, string> = {
    usor: 'Ușor',
    mediu: 'Mediu',
    greu: 'Greu',
}

/**
 * Card grid for recipe artifacts.
 *
 * Each card: 16:9 image header (lazy-loaded from `imageUrl` if set, falling
 * back to a Wikimedia query via /api/recipe-images when only `imageQuery`
 * exists), title, optional subtitle (1 line clamp), and a chip strip with
 * time + difficulty + servings. Click → opens the source conversation
 * and anchors to the message that produced the artifact.
 */
export function RecipesGrid({
    recipes,
    className,
}: {
    recipes: LibraryRecipeRow[]
    className?: string
}) {
    return (
        <ul
            className={cn(
                "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
                className,
            )}
            aria-label="Recipes grid"
        >
            {recipes.map((r) => (
                <li key={r.id}>
                    <RecipeCard recipe={r} />
                </li>
            ))}
        </ul>
    )
}

function RecipeCard({ recipe }: { recipe: LibraryRecipeRow }) {
    return (
        <Link
            href={`/?conversation=${encodeURIComponent(recipe.conversationId)}#message-artifact-${encodeURIComponent(recipe.identifier)}`}
            className={cn(
                "group/recipe-card flex h-full flex-col overflow-hidden rounded-xl border border-border/55 bg-card shadow-sm transition-all",
                "hover:-translate-y-0.5 hover:border-border hover:shadow-md",
            )}
        >
            <RecipeImage recipe={recipe} />
            <div className="flex flex-1 flex-col gap-2 px-3.5 py-3">
                <div>
                    <h3 className="line-clamp-1 text-sm font-semibold text-foreground">{recipe.title}</h3>
                    {recipe.subtitle ? (
                        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                            {recipe.subtitle}
                        </p>
                    ) : null}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground tabular-nums">
                    {recipe.totalMinutes ? (
                        <Chip icon={<Clock className="size-3" />}>{formatMinutes(recipe.totalMinutes)}</Chip>
                    ) : null}
                    {recipe.difficulty ? (
                        <Chip icon={<Flame className="size-3" />}>{DIFFICULTY_LABEL[recipe.difficulty]}</Chip>
                    ) : null}
                    {recipe.servingsDefault ? (
                        <Chip icon={<Users className="size-3" />}>
                            {recipe.servingsDefault}
                            <span className="ml-0.5 text-muted-foreground/70">
                                {recipe.servingsLabel ?? 'porții'}
                            </span>
                        </Chip>
                    ) : null}
                </div>
                <div className="flex items-center justify-between text-[10.5px] text-muted-foreground/75">
                    <span className="truncate normal-case">
                        {recipe.conversationTitle ?? 'Conversation'}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatRelativeTime(recipe.createdAt)}</span>
                </div>
            </div>
        </Link>
    )
}

function RecipeImage({ recipe }: { recipe: LibraryRecipeRow }) {
    const [resolvedSrc, setResolvedSrc] = React.useState<string | null>(recipe.imageUrl ?? null)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
        // If the recipe ships a direct imageUrl, use it. Otherwise hit the
        // Wikimedia search via /api/recipe-images for the imageQuery. We
        // request just 1 image — for the card thumbnail nothing more is needed.
        if (recipe.imageUrl) {
            setResolvedSrc(recipe.imageUrl)
            return
        }
        if (!recipe.imageQuery) {
            setResolvedSrc(null)
            return
        }
        let cancelled = false
        const url = `/api/recipe-images?q=${encodeURIComponent(recipe.imageQuery)}&limit=1`
        fetch(url)
            .then((r) => r.ok ? r.json() : null)
            .then((j: { images?: Array<{ url: string }> } | null) => {
                if (cancelled) return
                setResolvedSrc(j?.images?.[0]?.url ?? null)
            })
            .catch(() => { if (!cancelled) setResolvedSrc(null) })
        return () => { cancelled = true }
    }, [recipe.imageUrl, recipe.imageQuery])

    if (!resolvedSrc || failed) {
        return (
            <div className="flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-amber-500/10 via-orange-500/10 to-rose-500/10">
                <ChefHat className="size-8 text-foreground/35" strokeWidth={1.4} aria-hidden />
            </div>
        )
    }
    return (
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted/40">
            <img
                src={resolvedSrc}
                alt=""
                loading="lazy"
                onError={() => setFailed(true)}
                className="size-full object-cover transition-transform duration-300 group-hover/recipe-card:scale-[1.03]"
            />
        </div>
    )
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted/55 px-1.5 py-0.5 text-foreground/75">
            <span className="text-muted-foreground/65">{icon}</span>
            {children}
        </span>
    )
}

function formatMinutes(min: number): string {
    if (min < 60) return `${min} min`
    const h = Math.floor(min / 60)
    const m = min % 60
    if (m === 0) return `${h} h`
    return `${h}h ${m}m`
}
