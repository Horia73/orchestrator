/**
 * End-to-end smoke for the workout storage layer:
 *   - writeSessionLog → file exists, parses back as expected
 *   - writeExerciseHistory → file exists, merges correctly on second write
 *   - appendHistoryEntry → file created, line present, dedups by sessionId
 *   - listRecentSessionSlugs → newest first (only the slugs this test wrote)
 *
 * Isolation: every write uses a `smoke-{sessionId}` prefix and a temp
 * exercise id (`smoke-bench-press`), so we can clean up exactly what this
 * test produced without touching the user's real workout history.
 *
 * Run: npx tsx scripts/smoke-workout-storage.ts
 */
import fs from 'fs'

import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { buildSessionLog, formatHistoryEntryLine, formatSessionMarkdown, mergeExerciseHistory } from '@/lib/workout/save-session'
import {
    appendHistoryEntry,
    historyMarkdownPath,
    listRecentSessionSlugs,
    readExerciseHistory,
    readSessionLog,
    sessionJsonPath,
    sessionMarkdownPath,
    exerciseHistoryPath,
    writeExerciseHistory,
    writeSessionLog,
} from '@/lib/workout/storage'

const TEST_EX_ID = 'smoke-bench-press'
const TEST_SESSION_PREFIX = 'smoke-test-' + Date.now() + '-'

const writtenSessionSlugs: string[] = []
const writtenSessionIds: string[] = []

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

function cleanup() {
    // Remove only what THIS test wrote. Never blow away the real workouts dir.
    for (const slug of writtenSessionSlugs) {
        try { fs.unlinkSync(sessionJsonPath(slug)) } catch { /* ignore */ }
        try { fs.unlinkSync(sessionMarkdownPath(slug)) } catch { /* ignore */ }
    }
    try { fs.unlinkSync(exerciseHistoryPath(TEST_EX_ID)) } catch { /* ignore */ }
    // Strip any HISTORY.md lines we appended.
    try {
        const histPath = historyMarkdownPath()
        if (fs.existsSync(histPath)) {
            const content = fs.readFileSync(histPath, 'utf8')
            const cleaned = content.split('\n').filter((l) => !writtenSessionIds.some((id) => l.includes(`session:${id}`))).join('\n')
            if (cleaned !== content) fs.writeFileSync(histPath, cleaned, 'utf8')
        }
    } catch { /* ignore */ }
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

try {
    const workoutJson = JSON.stringify({
        sessionId: TEST_SESSION_PREFIX + 'minimal',
        title: 'Smoke Push',
        units: 'kg',
        groups: [{
            kind: 'straight',
            exercises: [{
                id: TEST_EX_ID,
                name: 'Smoke Bench Press',
                kind: 'weighted',
                muscleGroups: ['chest'],
                planned: [
                    { weightKg: 60, reps: 8 },
                    { weightKg: 60, reps: 8 },
                    { weightKg: 60, reps: 8 },
                ],
            }],
        }],
    })
    const parsed = parseWorkoutArtifact(workoutJson)
    if (!parsed.ok) throw new Error(`fixture parse: ${parsed.error}`)
    const workout = parsed.value

    const baseState = {
        sessionId: TEST_SESSION_PREFIX + 'sess-001',
        startedAt: new Date(Date.now() - 1800_000).toISOString(),
        completedAt: new Date().toISOString(),
        logsByExerciseId: {
            [TEST_EX_ID]: {
                sets: [
                    { completed: true, actualWeightKg: 60, actualReps: 8, actualRpe: 7.5 },
                    { completed: true, actualWeightKg: 60, actualReps: 8, actualRpe: 8 },
                    { completed: true, actualWeightKg: 65, actualReps: 5, actualRpe: 9 },
                ],
            },
        },
        _v: 1 as const,
    }

    // Unique-per-run slug so two parallel CI processes don't collide.
    const slug1 = TEST_SESSION_PREFIX + 'sess-001'
    const log1 = buildSessionLog({ ...workout, sessionId: baseState.sessionId }, baseState)
    const md = formatSessionMarkdown(log1)

    // === writeSessionLog ===
    const { jsonPath, mdPath } = writeSessionLog(slug1, log1, md)
    writtenSessionSlugs.push(slug1)
    writtenSessionIds.push(baseState.sessionId)
    check('storage: session JSON file exists', fs.existsSync(jsonPath))
    check('storage: session MD file exists', fs.existsSync(mdPath))
    const readBack = readSessionLog(slug1)
    check('storage: session reads back', readBack !== null && readBack.sessionId === baseState.sessionId)
    check('storage: session preserves volume', readBack?.totalVolumeKg === log1.totalVolumeKg)

    // === writeExerciseHistory ===
    const merged = mergeExerciseHistory(null, workout, log1, log1.exercises[0])
    const exPath = writeExerciseHistory(merged)
    check('storage: exercise history file exists', fs.existsSync(exPath))
    const readEx = readExerciseHistory(TEST_EX_ID)
    check('storage: exercise history reads back', readEx !== null && readEx.id === TEST_EX_ID)
    check('storage: PB populated', readEx?.personalBest?.weightKg === 65 || readEx?.personalBest?.weightKg === 60)

    // === appendHistoryEntry ===
    appendHistoryEntry(formatHistoryEntryLine(log1), baseState.sessionId)
    const histPath = historyMarkdownPath()
    check('storage: HISTORY.md created', fs.existsSync(histPath))
    const histContent = fs.readFileSync(histPath, 'utf8')
    check('storage: HISTORY.md contains session line', histContent.includes('Smoke Push') && histContent.includes(baseState.sessionId))

    appendHistoryEntry(formatHistoryEntryLine(log1), baseState.sessionId)
    const histAfter = fs.readFileSync(histPath, 'utf8')
    const occurrences = (histAfter.match(new RegExp(baseState.sessionId, 'g')) || []).length
    check('storage: HISTORY.md dedupes same sessionId', occurrences === 1, `found ${occurrences} occurrences`)

    // === Second session merges into exercise history ===
    const sess2Id = TEST_SESSION_PREFIX + 'sess-002'
    const slug2 = TEST_SESSION_PREFIX + 'sess-002'
    const state2 = {
        ...baseState,
        sessionId: sess2Id,
        startedAt: new Date(Date.now() - 86400_000).toISOString(),
        completedAt: new Date(Date.now() - 86400_000 + 1800_000).toISOString(),
    }
    const log2 = buildSessionLog({ ...workout, sessionId: sess2Id }, state2)
    const merged2 = mergeExerciseHistory(readEx, workout, log2, log2.exercises[0])
    writeExerciseHistory(merged2)
    const readEx2 = readExerciseHistory(TEST_EX_ID)
    check('storage: second session added to exercise history', (readEx2?.sessions.length ?? 0) === 2)

    writeSessionLog(slug2, log2, formatSessionMarkdown(log2))
    writtenSessionSlugs.push(slug2)
    writtenSessionIds.push(sess2Id)

    // === listRecentSessionSlugs ===
    // Filter to only the slugs this test wrote — listRecent returns ALL files in
    // the directory (the real user history could contain dozens), so we just
    // verify our 2 slugs are present and ordered.
    const allRecent = listRecentSessionSlugs(200)
    const ourSlugs = allRecent.filter((s) => s.startsWith(TEST_SESSION_PREFIX) || writtenSessionSlugs.includes(s))
    check('storage: our 2 slugs both appear in listRecent', ourSlugs.length === 2, ourSlugs)
    check('storage: slugs are sorted newest first', ourSlugs[0] >= ourSlugs[1])
} catch (e) {
    console.error('Fatal:', e)
    failures += 1
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
// process.on('exit') will run cleanup before the process truly terminates.
process.exit(failures === 0 ? 0 : 1)
