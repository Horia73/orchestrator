"use client"

import * as React from "react"
import { Check, Dumbbell, Plus, User, X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Exercise, MuscleGroup, WorkoutEquipment, WorkoutUnits } from "@/lib/workout/schema"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

type ExerciseKindChoice = 'weighted' | 'bodyweight'

const MAX_MUSCLES = 8

const MUSCLE_GROUPS: Array<{ label: string; items: Array<{ value: MuscleGroup; label: string }> }> = [
    {
        label: 'Push',
        items: [
            { value: 'chest', label: 'Chest' },
            { value: 'front_delt', label: 'Front delt' },
            { value: 'side_delt', label: 'Side delt' },
            { value: 'triceps', label: 'Triceps' },
        ],
    },
    {
        label: 'Back / Pull',
        items: [
            { value: 'lats', label: 'Lats' },
            { value: 'mid_back', label: 'Mid back' },
            { value: 'traps', label: 'Traps' },
            { value: 'rhomboids', label: 'Rhomboids' },
            { value: 'rear_delt', label: 'Rear delt' },
            { value: 'lower_back', label: 'Lower back' },
            { value: 'biceps', label: 'Biceps' },
            { value: 'forearms', label: 'Forearms' },
        ],
    },
    {
        label: 'Legs / Core',
        items: [
            { value: 'quads', label: 'Quads' },
            { value: 'hamstrings', label: 'Hams' },
            { value: 'glutes', label: 'Glutes' },
            { value: 'calves', label: 'Calves' },
            { value: 'adductors', label: 'Adductors' },
            { value: 'abductors', label: 'Abductors' },
            { value: 'abs', label: 'Abs' },
            { value: 'obliques', label: 'Obliques' },
        ],
    },
    {
        label: 'General',
        items: [
            { value: 'full_body', label: 'Full body' },
            { value: 'cardio', label: 'Cardio' },
        ],
    },
]

const EQUIPMENT_PRESETS: Array<{ value: WorkoutEquipment; label: string }> = [
    { value: 'barbell', label: 'Barbell' },
    { value: 'dumbbell', label: 'Dumbbell' },
    { value: 'machine', label: 'Machine' },
    { value: 'cable', label: 'Cable' },
    { value: 'bodyweight', label: 'Bodyweight' },
    { value: 'bench', label: 'Bench' },
]

export function AddExerciseButton({
    units,
    sessionApi,
    className,
}: {
    units: WorkoutUnits
    sessionApi: WorkoutSessionApi
    className?: string
}) {
    const [open, setOpen] = React.useState(false)

    return (
        <div className={cn("flex justify-start", className)}>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-background/55 px-3 py-2 text-[12px] font-semibold text-muted-foreground transition-colors",
                    "hover:border-primary/40 hover:bg-primary/[0.05] hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                <Dumbbell className="size-3.5" strokeWidth={2} />
                Add exercise
            </button>

            {open ? (
                <AddExerciseDialog
                    units={units}
                    onCancel={() => setOpen(false)}
                    onSave={(exercise) => {
                        sessionApi.addExercise(exercise)
                        setOpen(false)
                    }}
                />
            ) : null}
        </div>
    )
}

function AddExerciseDialog({
    units,
    onSave,
    onCancel,
}: {
    units: WorkoutUnits
    onSave: (exercise: Exercise) => void
    onCancel: () => void
}) {
    const [name, setName] = React.useState('')
    const [kind, setKind] = React.useState<ExerciseKindChoice>('weighted')
    const [sets, setSets] = React.useState(3)
    const [reps, setReps] = React.useState(10)
    const [weightKg, setWeightKg] = React.useState(20)
    const [restSec, setRestSec] = React.useState(90)
    const [muscles, setMuscles] = React.useState<MuscleGroup[]>(['full_body'])
    const [equipment, setEquipment] = React.useState<WorkoutEquipment[]>(['dumbbell'])
    const nameRef = React.useRef<HTMLInputElement>(null)

    React.useEffect(() => {
        nameRef.current?.focus()
    }, [])

    React.useEffect(() => {
        setEquipment((prev) => {
            if (kind === 'bodyweight') return ['bodyweight']
            return prev.filter((item) => item !== 'bodyweight').length > 0
                ? prev.filter((item) => item !== 'bodyweight')
                : ['dumbbell']
        })
    }, [kind])

    const canSave = name.trim().length > 0 && sets > 0 && reps >= 0 && muscles.length > 0

    const handleSave = () => {
        if (!canSave) return
        onSave(buildExercise({
            name,
            kind,
            sets,
            reps,
            weightKg,
            restSec,
            muscles,
            equipment,
        }))
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Add exercise"
            className="fixed inset-0 z-50 flex items-end justify-center bg-background/70 px-3 py-3 backdrop-blur-sm sm:items-center sm:px-4"
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation()
                    onCancel()
                }
            }}
        >
            <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border/70 bg-popover shadow-xl">
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                        <Plus className="size-4" strokeWidth={2.25} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-foreground">Add exercise</div>
                        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                            Adds a straight exercise to this workout now. It appears immediately and is included in progress and the final summary.
                        </p>
                    </div>
                </div>

                <label className="mt-4 block">
                    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                        Name
                    </span>
                    <input
                        ref={nameRef}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="e.g. Leg extension"
                        className="h-10 w-full rounded-md border border-border bg-background px-2.5 text-base text-foreground outline-none transition-shadow placeholder:text-muted-foreground/70 focus:ring-2 focus:ring-ring"
                    />
                </label>

                <div className="mt-3 grid grid-cols-2 gap-2">
                    <KindButton
                        active={kind === 'weighted'}
                        icon={<Dumbbell className="size-3.5" strokeWidth={2} />}
                        label="Weighted"
                        onClick={() => setKind('weighted')}
                    />
                    <KindButton
                        active={kind === 'bodyweight'}
                        icon={<User className="size-3.5" strokeWidth={2} />}
                        label="Bodyweight"
                        onClick={() => setKind('bodyweight')}
                    />
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                    <NumberInput label="Sets" value={sets} step={1} min={1} max={20} onChange={setSets} />
                    <NumberInput label="Reps" value={reps} step={1} min={0} max={100} onChange={setReps} />
                    {kind === 'weighted' ? (
                        <NumberInput label={units} value={weightKg} step={0.5} min={0} max={500} onChange={setWeightKg} />
                    ) : (
                        <NumberInput label="Rest s" value={restSec} step={15} min={0} max={600} onChange={setRestSec} />
                    )}
                </div>

                {kind === 'weighted' ? (
                    <div className="mt-2">
                        <NumberInput label="Rest s" value={restSec} step={15} min={0} max={600} onChange={setRestSec} />
                    </div>
                ) : null}

                <ChoiceSection label={`Muscles · ${muscles.length}/${MAX_MUSCLES}`}>
                    <div className="flex flex-col gap-2">
                        {MUSCLE_GROUPS.map((group) => (
                            <div key={group.label} className="min-w-0">
                                <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">
                                    {group.label}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {group.items.map((item) => (
                                        <ToggleChip
                                            key={item.value}
                                            active={muscles.includes(item.value)}
                                            disabled={!muscles.includes(item.value) && muscles.length >= MAX_MUSCLES}
                                            onClick={() => setMuscles((current) => toggleRequired(current, item.value, 'full_body', MAX_MUSCLES))}
                                        >
                                            {item.label}
                                        </ToggleChip>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </ChoiceSection>

                <ChoiceSection label="Equipment">
                    {EQUIPMENT_PRESETS.map((item) => (
                        <ToggleChip
                            key={item.value}
                            active={equipment.includes(item.value)}
                            onClick={() => setEquipment((current) => toggleOptional(current, item.value))}
                        >
                            {item.label}
                        </ToggleChip>
                    ))}
                </ChoiceSection>

                </div>

                <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 bg-popover px-4 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="size-3.5" strokeWidth={2} />
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!canSave}
                        onClick={handleSave}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100"
                    >
                        <Check className="size-3.5" strokeWidth={2} />
                        Add
                    </button>
                </div>
            </div>
        </div>
    )
}

function buildExercise(input: {
    name: string
    kind: ExerciseKindChoice
    sets: number
    reps: number
    weightKg: number
    restSec: number
    muscles: MuscleGroup[]
    equipment: WorkoutEquipment[]
}): Exercise {
    const name = input.name.trim()
    const planned = Array.from({ length: input.sets }, () => (
        input.kind === 'weighted'
            ? { kind: 'working' as const, weightKg: input.weightKg, reps: input.reps }
            : { kind: 'working' as const, reps: input.reps }
    ))
    if (input.kind === 'bodyweight') {
        return {
            id: slugifyExerciseName(name),
            name,
            kind: 'bodyweight',
            equipment: input.equipment.slice(0, 6),
            muscleGroups: input.muscles.slice(0, MAX_MUSCLES),
            defaultRestSec: input.restSec,
            planned,
        }
    }
    return {
        id: slugifyExerciseName(name),
        name,
        kind: 'weighted',
        equipment: input.equipment.slice(0, 6),
        muscleGroups: input.muscles.slice(0, MAX_MUSCLES),
        defaultRestSec: input.restSec,
        planned,
    }
}

function slugifyExerciseName(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72)
    return slug || `custom-exercise-${Date.now().toString(36)}`
}

function toggleRequired<T>(items: readonly T[], item: T, fallback: T, max = Number.POSITIVE_INFINITY): T[] {
    if (items.includes(item)) {
        const next = items.filter((value) => value !== item)
        return next.length > 0 ? next : [fallback]
    }
    const next = [...items.filter((value) => value !== fallback), item]
    return next.slice(0, max)
}

function toggleOptional<T>(items: readonly T[], item: T): T[] {
    return items.includes(item)
        ? items.filter((value) => value !== item)
        : [...items, item].slice(0, 6)
}

function KindButton({
    active,
    icon,
    label,
    onClick,
}: {
    active: boolean
    icon: React.ReactNode
    label: string
    onClick: () => void
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "inline-flex h-10 items-center justify-center gap-1.5 rounded-md border px-3 text-[12px] font-semibold transition-colors",
                active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground/75 hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            {icon}
            {label}
        </button>
    )
}

function NumberInput({
    label,
    value,
    step,
    min,
    max,
    onChange,
}: {
    label: string
    value: number
    step: number
    min: number
    max: number
    onChange: (value: number) => void
}) {
    return (
        <label className="min-w-0">
            <span className="mb-1 block truncate text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
            </span>
            <input
                type="number"
                value={value}
                step={step}
                min={min}
                max={max}
                onChange={(event) => {
                    const next = Number(event.target.value)
                    if (!Number.isNaN(next)) onChange(Math.min(max, Math.max(min, next)))
                }}
                className="h-10 w-full rounded-md border border-border bg-background px-2 text-right text-base font-semibold tabular-nums text-foreground outline-none transition-shadow focus:ring-2 focus:ring-ring"
            />
        </label>
    )
}

function ChoiceSection({
    label,
    children,
}: {
    label: string
    children: React.ReactNode
}) {
    return (
        <div className="mt-3">
            <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
            </div>
            <div className="flex flex-wrap gap-1.5">{children}</div>
        </div>
    )
}

function ToggleChip({
    active,
    disabled,
    onClick,
    children,
}: {
    active: boolean
    disabled?: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "inline-flex h-7 items-center rounded-md border px-2 text-[11px] font-medium transition-colors",
                active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-foreground/70 hover:bg-muted hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-background disabled:hover:text-foreground/70",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            {children}
        </button>
    )
}
