"use client"

import * as React from "react"
import {
    Dumbbell,
    Cog,
    Cable,
    User,
    Activity,
    Box,
    Footprints,
    Bike,
    Waves,
    CircleDot,
    Layers,
    type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutEquipment } from "@/lib/workout/schema"

/**
 * Equipment chip row. Tiny lucide icons + label, wraps under the title.
 *
 * Each chip uses an opinionated icon — `Dumbbell` is the fallback when an
 * equipment type doesn't have a specific lucide match. Labels match the
 * schema's kebab-case enum but rendered in Title Case.
 */
export function EquipmentChips({
    equipment,
    className,
}: {
    equipment: readonly WorkoutEquipment[]
    className?: string
}) {
    if (!equipment.length) return null
    return (
        <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
            {equipment.map((e) => {
                const Icon = EQUIPMENT_ICON[e] ?? Dumbbell
                return (
                    <span
                        key={e}
                        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10.5px] font-medium tracking-tight text-foreground/75"
                    >
                        <Icon className="size-3" aria-hidden strokeWidth={1.75} />
                        {EQUIPMENT_LABEL[e] ?? e}
                    </span>
                )
            })}
        </div>
    )
}

const EQUIPMENT_ICON: Partial<Record<WorkoutEquipment, LucideIcon>> = {
    barbell: Dumbbell,
    dumbbell: Dumbbell,
    kettlebell: CircleDot,
    machine: Cog,
    cable: Cable,
    bodyweight: User,
    band: Waves,
    plates: Layers,
    bench: Box,
    rack: Box,
    pullup_bar: Activity,
    box: Box,
    rower: Activity,
    bike: Bike,
    treadmill: Footprints,
    sled: Box,
    rings: CircleDot,
    trx: Cable,
    mat: Box,
    foam_roller: CircleDot,
    jump_rope: Activity,
}

const EQUIPMENT_LABEL: Partial<Record<WorkoutEquipment, string>> = {
    barbell: 'Barbell',
    dumbbell: 'Dumbbell',
    kettlebell: 'Kettlebell',
    machine: 'Machine',
    cable: 'Cable',
    bodyweight: 'Bodyweight',
    band: 'Band',
    plates: 'Plates',
    bench: 'Bench',
    rack: 'Rack',
    pullup_bar: 'Pull-up bar',
    box: 'Box',
    rower: 'Rower',
    bike: 'Bike',
    treadmill: 'Treadmill',
    sled: 'Sled',
    rings: 'Rings',
    trx: 'TRX',
    mat: 'Mat',
    foam_roller: 'Foam roller',
    jump_rope: 'Jump rope',
    other: 'Other',
}
