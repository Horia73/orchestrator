import fs from 'fs'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'
import type { SessionLog, ExerciseHistory } from './save-session'

// ---------------------------------------------------------------------------
// Workout file storage (server-side only).
//
// All paths under `workouts/` inside the workspace. Created lazily on first
// write — we never assume the user pre-created the directory.
//
// Writes are atomic: write to a `.tmp` sibling then `rename()` into place,
// so a crash mid-write can't leave a half-formed JSON file that the AI tool
// would later refuse to parse.
//
// Reads return `null` for missing files (not exceptions) so callers can
// distinguish "fresh exercise, no history" from "I/O exploded".
// ---------------------------------------------------------------------------

export function workoutsDir(): string {
    return path.join(/* turbopackIgnore: true */ activeRuntimePaths().workspaceDir, 'workouts')
}

export function sessionsDir(): string {
    return path.join(workoutsDir(), 'sessions')
}

export function exercisesDir(): string {
    return path.join(workoutsDir(), 'exercises')
}

/**
 * In-progress session state lives here, keyed by the stable artifact row id
 * (NOT the sessionId), so a session resumes when the artifact is re-opened
 * from the inbox or on another device. This is the live autosave; the
 * finished-session history under `sessions/` is written separately on Finish.
 */
export function activeSessionsDir(): string {
    return path.join(workoutsDir(), 'active')
}

export function historyMarkdownPath(): string {
    return path.join(workoutsDir(), 'HISTORY.md')
}

export function sessionJsonPath(slug: string): string {
    return path.join(sessionsDir(), `${slug}.json`)
}

export function sessionMarkdownPath(slug: string): string {
    return path.join(sessionsDir(), `${slug}.md`)
}

export function exerciseHistoryPath(id: string): string {
    return path.join(exercisesDir(), `${id}.json`)
}

/** Sanitize an artifact id into a safe single-segment filename. */
function safeArtifactId(artifactId: string): string {
    return artifactId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'artifact'
}

export function activeSessionPath(artifactId: string): string {
    return path.join(activeSessionsDir(), `${safeArtifactId(artifactId)}.json`)
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

/**
 * Atomic write: write to a temp sibling, then rename. POSIX rename is atomic
 * on the same filesystem, so concurrent readers never see a half-written file.
 */
function writeAtomic(filePath: string, contents: string): void {
    ensureDir(path.dirname(filePath))
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, contents, 'utf8')
    fs.renameSync(tmp, filePath)
}

/** Read JSON or return null on missing/parse-error. Never throws on read. */
function readJsonOrNull<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) return null
        const raw = fs.readFileSync(filePath, 'utf8')
        return JSON.parse(raw) as T
    } catch {
        return null
    }
}

// === public API ============================================================

export function writeSessionLog(slug: string, log: SessionLog, markdown: string): { jsonPath: string; mdPath: string } {
    const jsonPath = sessionJsonPath(slug)
    const mdPath = sessionMarkdownPath(slug)
    writeAtomic(jsonPath, JSON.stringify(log, null, 2))
    writeAtomic(mdPath, markdown)
    return { jsonPath, mdPath }
}

export function readSessionLog(slug: string): SessionLog | null {
    return readJsonOrNull<SessionLog>(sessionJsonPath(slug))
}

export function writeExerciseHistory(history: ExerciseHistory): string {
    const filePath = exerciseHistoryPath(history.id)
    writeAtomic(filePath, JSON.stringify(history, null, 2))
    return filePath
}

export function readExerciseHistory(id: string): ExerciseHistory | null {
    return readJsonOrNull<ExerciseHistory>(exerciseHistoryPath(id))
}

// === active (in-progress) session autosave =================================

/**
 * Persist the live, in-progress session state for an artifact. Opaque payload
 * (the client's `WorkoutSessionState` plus an `updatedAt` stamp) — the server
 * only stores and returns it; the client owns its shape. Keyed by artifactId so
 * resume works across reloads and devices, independent of localStorage.
 */
export function writeActiveSession(artifactId: string, payload: unknown): string {
    const filePath = activeSessionPath(artifactId)
    writeAtomic(filePath, JSON.stringify(payload))
    return filePath
}

export function readActiveSession<T = unknown>(artifactId: string): T | null {
    return readJsonOrNull<T>(activeSessionPath(artifactId))
}

export function deleteActiveSession(artifactId: string): void {
    try {
        const filePath = activeSessionPath(artifactId)
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {
        /* best-effort */
    }
}

export function listExerciseHistoryIds(): string[] {
    try {
        if (!fs.existsSync(exercisesDir())) return []
        return fs.readdirSync(exercisesDir())
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
    } catch {
        return []
    }
}

/**
 * Append a line to HISTORY.md (newest-first). Creates the file with a header
 * if missing. Idempotent for the same sessionId — if a line for that session
 * already exists, we replace it.
 */
export function appendHistoryEntry(line: string, sessionId: string): void {
    const filePath = historyMarkdownPath()
    ensureDir(path.dirname(filePath))
    const header = '# Workout history\n\nNewest first.\n\n'

    let body = ''
    if (fs.existsSync(filePath)) {
        body = fs.readFileSync(filePath, 'utf8')
    } else {
        body = header
    }

    // Strip any existing line for this sessionId (defensive — replays / edits
    // shouldn't leave duplicates).
    const sessionTag = `<!-- session:${sessionId} -->`
    const lines = body.split('\n').filter((l) => !l.includes(sessionTag))
    const newLine = `${line} ${sessionTag}`

    // Insert after the header (first blank line after "# Workout history").
    const headerEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '' && lines[i - 1]?.trim() === 'Newest first.')
    const insertAt = headerEnd >= 0 ? headerEnd + 1 : lines.length
    lines.splice(insertAt, 0, newLine)

    writeAtomic(filePath, lines.join('\n'))
}

export function listRecentSessionSlugs(limit: number): string[] {
    try {
        if (!fs.existsSync(sessionsDir())) return []
        return fs.readdirSync(sessionsDir())
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
            // Slugs start with YYYY-MM-DD, so lexicographic descending = newest first.
            .sort()
            .reverse()
            .slice(0, Math.max(0, Math.min(200, limit)))
    } catch {
        return []
    }
}
