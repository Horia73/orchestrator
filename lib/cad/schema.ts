import { z } from 'zod'

// ---------------------------------------------------------------------------
// application/vnd.ant.cad — interactive 3D CAD model viewer artifact.
//
// The body is a small JSON manifest that points at real files the CAD skill
// generated in the agent workspace (GLB for the in-app viewer, STEP/STL/3MF
// for download). The viewer fetches the referenced files through
// /api/workspace/files, so every path must be workspace-relative.
//
// Mirrors the recipe / workout strict-artifact pattern: zod schema here,
// parse function below, registered in lib/artifacts/validation.ts, schema
// documented for the model in lib/integrations/doctrines/cad.ts.
// ---------------------------------------------------------------------------

/** Workspace-relative path: rejects absolute host paths and `..` escapes so a
 *  malformed artifact gets a precise repair signal instead of a viewer 404. */
const WorkspaceRelativePathSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p), {
        message: 'must be a workspace-relative path, not an absolute path',
    })
    .refine((p) => !p.split(/[\\/]/).includes('..'), {
        message: 'must not contain ".." path segments',
    })

export const CadFileKindSchema = z.enum(['step', 'stl', '3mf', 'glb', 'source', 'other'])
export type CadFileKind = z.infer<typeof CadFileKindSchema>

export const CadArtifactFileSchema = z.object({
    /** Workspace-relative path, e.g. "files/cad/st3215-adapter/st3215-adapter.step". */
    path: WorkspaceRelativePathSchema,
    /** Short chip label ("STEP", "STL", "Source"). Defaults from the extension. */
    label: z.string().min(1).max(80).optional(),
    kind: CadFileKindSchema.optional(),
})
export type CadArtifactFile = z.infer<typeof CadArtifactFileSchema>

export const CadArtifactSchema = z.object({
    /** Display name of the part or assembly ("ST3215 mounting adapter"). */
    name: z.string().min(1).max(160),
    /** 1–3 sentences: what it is, key fit/printing context. */
    description: z.string().max(1200).optional(),
    model: z.object({
        /** Workspace-relative path to the native GLB the viewer renders. */
        glb: WorkspaceRelativePathSchema.refine((p) => /\.glb$/i.test(p), {
            message: 'model.glb must point to a .glb file',
        }),
    }),
    /** Downloadable deliverables (STEP/STL/3MF/source). The GLB does not need
     *  to be repeated here unless the user asked for it as a deliverable. */
    files: z.array(CadArtifactFileSchema).max(24).optional(),
    /** Overall bounding box in millimeters, from `scripts/inspect refs --facts`. */
    boundingBoxMm: z
        .object({
            x: z.number().positive(),
            y: z.number().positive(),
            z: z.number().positive(),
        })
        .optional(),
    /** Solid/part count for assemblies. */
    partCount: z.number().int().positive().max(10_000).optional(),
    /** Short caveats/assumptions worth keeping next to the model. */
    notes: z.array(z.string().min(1).max(400)).max(12).optional(),
})
export type CadArtifact = z.infer<typeof CadArtifactSchema>

export type CadArtifactParseResult =
    | { ok: true; value: CadArtifact }
    | { ok: false; error: string }

/**
 * Parse the body of an `application/vnd.ant.cad` artifact. Returns the first
 * Zod issue only, mirroring the workout/recipe parsers — one actionable error
 * at a time is what the in-turn repair pass works best with.
 */
export function parseCadArtifact(rawJson: string): CadArtifactParseResult {
    let value: unknown
    try {
        value = JSON.parse(rawJson)
    } catch (e) {
        return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
    const parsed = CadArtifactSchema.safeParse(value)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const path = first.path.length ? first.path.join('.') : '(root)'
        return { ok: false, error: `${path}: ${first.message}` }
    }
    return { ok: true, value: parsed.data }
}

/** Default download-chip label for a CAD file entry. */
export function cadFileLabel(file: CadArtifactFile): string {
    if (file.label) return file.label
    if (file.kind && file.kind !== 'other') {
        return file.kind === 'source' ? 'Source' : file.kind.toUpperCase()
    }
    const ext = file.path.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'py') return 'Source'
    return ext ? ext.toUpperCase() : 'File'
}
