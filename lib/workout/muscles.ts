import type { MuscleGroup } from './schema'

/**
 * Single source of truth for muscle-group display: human labels, macro-group
 * categorization (push / pull / lower / core / cardio), and the Tailwind
 * classes that color both the inline exercise chips and the Library muscle-
 * balance bars. Kept here (not in a renderer component) so the artifact
 * surface and the Library dashboard stay visually consistent.
 */

export const MUSCLE_LABEL: Partial<Record<MuscleGroup, string>> = {
    chest: 'Chest',
    front_delt: 'Front Delt',
    side_delt: 'Side Delt',
    rear_delt: 'Rear Delt',
    triceps: 'Triceps',
    lats: 'Lats',
    mid_back: 'Mid Back',
    traps: 'Traps',
    rhomboids: 'Rhomboids',
    biceps: 'Biceps',
    forearms: 'Forearms',
    quads: 'Quads',
    hamstrings: 'Hamstrings',
    glutes: 'Glutes',
    calves: 'Calves',
    adductors: 'Adductors',
    abductors: 'Abductors',
    abs: 'Abs',
    obliques: 'Obliques',
    lower_back: 'Lower Back',
    full_body: 'Full Body',
    cardio: 'Cardio',
}

/** Human label for any muscle string, falling back to a prettified slug. */
export function muscleLabel(muscle: string): string {
    const known = MUSCLE_LABEL[muscle as MuscleGroup]
    if (known) return known
    return muscle
        .split('_')
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join(' ')
}

export type MuscleMacro = 'push' | 'pull' | 'lower' | 'core' | 'cardio' | 'other'

const MACRO_BY_MUSCLE: Partial<Record<MuscleGroup, MuscleMacro>> = {
    chest: 'push', front_delt: 'push', side_delt: 'push', triceps: 'push',
    rear_delt: 'pull', lats: 'pull', mid_back: 'pull', traps: 'pull', rhomboids: 'pull', biceps: 'pull', forearms: 'pull',
    quads: 'lower', hamstrings: 'lower', glutes: 'lower', calves: 'lower', adductors: 'lower', abductors: 'lower',
    abs: 'core', obliques: 'core', lower_back: 'core',
    full_body: 'cardio', cardio: 'cardio',
}

/** Macro group for any muscle string. Unknown muscles fall back to `other`. */
export function muscleMacro(muscle: string): MuscleMacro {
    return MACRO_BY_MUSCLE[muscle as MuscleGroup] ?? 'other'
}

/** Soft chip background + text used under exercise names. */
export const MACRO_CHIP_CLASS: Record<MuscleMacro, string> = {
    push: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    pull: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    lower: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    core: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    cardio: 'bg-slate-500/10 text-slate-700 dark:text-slate-300',
    other: 'bg-muted text-muted-foreground',
}

/** Solid fill used for the muscle-balance bars in the Library. */
export const MACRO_BAR_CLASS: Record<MuscleMacro, string> = {
    push: 'bg-sky-500',
    pull: 'bg-violet-500',
    lower: 'bg-emerald-500',
    core: 'bg-amber-500',
    cardio: 'bg-slate-400',
    other: 'bg-muted-foreground/40',
}

export const MACRO_LABEL: Record<MuscleMacro, string> = {
    push: 'Push',
    pull: 'Pull',
    lower: 'Legs',
    core: 'Core',
    cardio: 'Cardio',
    other: 'Other',
}
