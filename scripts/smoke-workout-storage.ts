/**
 * End-to-end smoke for the workout storage layer:
 *   - writeSessionLog → file exists, parses back as expected
 *   - writeExerciseHistory → file exists, merges correctly on second write
 *   - appendHistoryEntry → file created, line present, dedups by sessionId
 *   - listRecentSessionSlugs → newest first
 *
 * Uses a temporary subdirectory under workspace to avoid clobbering real
 * user data; tears down on exit.
 *
 * Run: npx tsx scripts/smoke-workout-storage.ts
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

// Override WORKSPACE_DIR before any storage imports
const TMP_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-storage-test-'))
process.env.ORCH_WORKSPACE_DIR = TMP_WORKSPACE

// Late-load so the override sticks.
async function main() {
    const { parseWorkoutArtifact } = await import('@/lib/workout/parser')
    const { buildSessionLog, buildSessionSlug, formatHistoryEntryLine, formatSessionMarkdown, mergeExerciseHistory } = await import('@/lib/workout/save-session')
    const {
        appendHistoryEntry,
        readExerciseHistory,
        readSessionLog,
        writeExerciseHistory,
        writeSessionLog,
        listRecentSessionSlugs,
        historyMarkdownPath,
        workoutsDir,
    } = await import('@/lib/workout/storage')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    console.log(`Using temp workspace: ${TMP_WORKSPACE}`)

    const workoutJson = JSON.stringify({
        sessionId: 'sess-001',
        title: 'Test Push',
        units: 'kg',
        groups: [{
            kind: 'straight',
            exercises: [{
                id: 'bench-press',
                name: 'Bench Press',
                kind: 'weighted',
                muscleGroups: ['chest'],
                planned: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }],
            }],
        }],
    })
    const parsed = parseWorkoutArtifact(workoutJson)
    if (!parsed.ok) throw new Error('fixture parse')
    const workout = parsed.value

    const state = {
        sessionId: 'sess-001',
        startedAt: new Date(Date.now() - 1800_000).toISOString(),
        completedAt: new Date().toISOString(),
        logsByExerciseId: {
            'bench-press': {
                sets: [
                    { completed: true, actualWeightKg: 60, actualReps: 8, actualRpe: 7.5 },
                    { completed: true, actualWeightKg: 60, actualReps: 8, actualRpe: 8 },
                    { completed: true, actualWeightKg: 65, actualReps: 5, actualRpe: 9 },
                ],
            },
        },
        _v: 1 as const,
    }

    const log = buildSessionLog(workout, state)
    const slug = buildSessionSlug(workout, state)
    const md = formatSessionMarkdown(log)

    // === writeSessionLog ===
    const { jsonPath, mdPath } = writeSessionLog(slug, log, md)
    check('storage: session JSON file exists', fs.existsSync(jsonPath), jsonPath)
    check('storage: session MD file exists', fs.existsSync(mdPath), mdPath)
    const readBack = readSessionLog(slug)
    check('storage: session reads back', readBack !== null && readBack.sessionId === 'sess-001')
    check('storage: session preserves volume', readBack?.totalVolumeKg === log.totalVolumeKg)

    // === writeExerciseHistory ===
    const merged = mergeExerciseHistory(null, workout, log, log.exercises[0])
    const exPath = writeExerciseHistory(merged)
    check('storage: exercise history file exists', fs.existsSync(exPath))
    const readEx = readExerciseHistory('bench-press')
    check('storage: exercise history reads back', readEx !== null && readEx.id === 'bench-press')
    check('storage: PB populated', readEx?.personalBest?.weightKg === 65 || readEx?.personalBest?.weightKg === 60)

    // === appendHistoryEntry ===
    appendHistoryEntry(formatHistoryEntryLine(log), 'sess-001')
    const histPath = historyMarkdownPath()
    check('storage: HISTORY.md created', fs.existsSync(histPath))
    const histContent = fs.readFileSync(histPath, 'utf8')
    check('storage: HISTORY.md contains session line', histContent.includes('Test Push') && histContent.includes('sess-001'))

    // Idempotent: appending the same sessionId replaces the line, doesn't duplicate.
    appendHistoryEntry(formatHistoryEntryLine(log), 'sess-001')
    const histAfter = fs.readFileSync(histPath, 'utf8')
    const occurrences = (histAfter.match(/sess-001/g) || []).length
    check('storage: HISTORY.md dedupes same sessionId', occurrences === 1, `found ${occurrences} occurrences`)

    // === Second session merges into exercise history ===
    const state2 = { ...state, sessionId: 'sess-002', startedAt: new Date(Date.now() - 86400_000).toISOString(), completedAt: new Date(Date.now() - 86400_000 + 1800_000).toISOString() }
    const log2 = buildSessionLog({ ...workout, sessionId: 'sess-002' }, state2)
    const merged2 = mergeExerciseHistory(readEx, workout, log2, log2.exercises[0])
    writeExerciseHistory(merged2)
    const readEx2 = readExerciseHistory('bench-press')
    check('storage: second session added to exercise history', (readEx2?.sessions.length ?? 0) === 2)

    // === listRecentSessionSlugs ===
    writeSessionLog(buildSessionSlug({ ...workout, sessionId: 'sess-002' }, state2), log2, formatSessionMarkdown(log2))
    const slugs = listRecentSessionSlugs(10)
    check('storage: listRecentSessionSlugs returns 2 slugs', slugs.length === 2, slugs)
    check('storage: slugs are sorted newest first', slugs[0] >= slugs[1])

    // === cleanup ===
    fs.rmSync(workoutsDir(), { recursive: true, force: true })

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
    process.exit(failures === 0 ? 0 : 1)
}

void main().catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
}).finally(() => {
    try { fs.rmSync(TMP_WORKSPACE, { recursive: true, force: true }) } catch { /* ignore */ }
})
