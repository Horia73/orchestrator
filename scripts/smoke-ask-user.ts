import { executeAskUser } from '@/lib/ai/tools/ask-user'
import { parseQuestionArtifact } from '@/lib/questions/schema'

function check(name: string, condition: boolean, detail?: unknown) {
    if (!condition) {
        console.error(`FAIL ${name}`, detail ?? '')
        process.exitCode = 1
        return
    }
    console.log(`ok ${name}`)
}

async function main() {
    // ── Executor: multi-question input → valid, parseable body ───────────
    const multi = await executeAskUser({
        questions: [
            {
                question: 'Which approach?',
                header: 'Approach',
                options: [{ label: 'Fast', description: 'ship now' }, { label: 'Safe' }],
            },
            {
                question: 'Which scopes?',
                header: 'Scopes',
                multiSelect: true,
                options: [{ label: 'Read' }, { label: 'Write' }, { label: 'Admin' }],
            },
        ],
    })
    check('multi-question executor succeeds', multi.success === true, multi)
    const multiBody = (multi.data as { body?: string } | undefined)?.body ?? ''
    const multiParsed = parseQuestionArtifact(multiBody)
    check('multi-question body parses', multiParsed.ok === true, multiParsed)
    if (multiParsed.ok) {
        check('two questions preserved', multiParsed.value.questions.length === 2)
        check('per-question multiSelect preserved', multiParsed.value.questions[1].multiSelect === true)
        check('allowOther defaults on', multiParsed.value.questions[0].allowOther === true)
        check('unanswered on emit', multiParsed.value.answered === undefined)
    }

    // ── Executor: caps at 4 questions ────────────────────────────────────
    const capped = await executeAskUser({
        questions: Array.from({ length: 6 }, (_, i) => ({
            question: `Q${i}?`,
            options: [{ label: 'a' }, { label: 'b' }],
        })),
    })
    const cappedBody = (capped.data as { body?: string } | undefined)?.body ?? ''
    const cappedParsed = parseQuestionArtifact(cappedBody)
    check('over-limit questions capped to 4', cappedParsed.ok && cappedParsed.value.questions.length === 4, cappedParsed)

    // ── Executor: legacy flat single-question input still works ───────────
    const legacyInput = await executeAskUser({
        question: 'Only one?',
        options: [{ label: 'Yes' }, { label: 'No' }],
        multiSelect: false,
    })
    check('legacy flat input succeeds', legacyInput.success === true, legacyInput)
    const legacyInputBody = (legacyInput.data as { body?: string } | undefined)?.body ?? ''
    const legacyInputParsed = parseQuestionArtifact(legacyInputBody)
    check('legacy flat input → one question', legacyInputParsed.ok && legacyInputParsed.value.questions.length === 1, legacyInputParsed)

    // ── Executor: rejects empty / bad input ──────────────────────────────
    const empty = await executeAskUser({ questions: [] })
    check('empty questions rejected', empty.success === false)
    const noOptions = await executeAskUser({ questions: [{ question: 'Hi?', options: [] }] })
    check('question without options rejected', noOptions.success === false)
    const badIdent = await executeAskUser({
        questions: [{ question: 'Hi?', options: [{ label: 'a' }] }],
        identifier: 'Not Kebab',
    })
    check('non-kebab identifier rejected', badIdent.success === false)

    // ── Parser: up-converts a legacy single-question stored body ─────────
    const legacyStored = JSON.stringify({
        question: 'Legacy?',
        header: 'Old',
        options: [{ label: 'A' }, { label: 'B' }],
        allowOther: true,
        answered: { selected: ['A'], other: 'freeform', answeredAt: '2026-07-01T00:00:00.000Z' },
    })
    const legacyStoredParsed = parseQuestionArtifact(legacyStored)
    check('legacy stored body parses', legacyStoredParsed.ok === true, legacyStoredParsed)
    if (legacyStoredParsed.ok) {
        const v = legacyStoredParsed.value
        check('legacy stored → one question', v.questions.length === 1)
        check('legacy header carried', v.questions[0].header === 'Old')
        check('legacy answer up-converted to responses[]', !!v.answered && v.answered.responses.length === 1)
        check('legacy selected preserved', v.answered?.responses[0].selected[0] === 'A')
        check('legacy other preserved', v.answered?.responses[0].other === 'freeform')
        check('legacy answeredAt preserved', v.answered?.answeredAt === '2026-07-01T00:00:00.000Z')
    }

    // ── Parser: rejects response/question count mismatch ─────────────────
    const mismatch = JSON.stringify({
        questions: [{ question: 'Q?', options: [{ label: 'a' }] }],
        answered: { responses: [{ selected: ['a'] }, { selected: [] }], answeredAt: '2026-07-01T00:00:00.000Z' },
    })
    const mismatchParsed = parseQuestionArtifact(mismatch)
    check('response/question count mismatch rejected', mismatchParsed.ok === false, mismatchParsed)

    // ── Parser: round-trips a submitted multi-question card ──────────────
    const answered = JSON.stringify({
        questions: [
            { question: 'A?', options: [{ label: 'x' }, { label: 'y' }] },
            { question: 'B?', multiSelect: true, options: [{ label: 'm' }, { label: 'n' }] },
        ],
        answered: {
            responses: [{ selected: ['x'] }, { selected: ['m', 'n'] }],
            answeredAt: '2026-07-08T10:00:00.000Z',
        },
    })
    const answeredParsed = parseQuestionArtifact(answered)
    check('submitted multi-card round-trips', answeredParsed.ok === true, answeredParsed)
    if (answeredParsed.ok) {
        check('multi answer responses aligned', answeredParsed.value.answered?.responses.length === 2)
        check('multi answer multi-pick preserved', answeredParsed.value.answered?.responses[1].selected.length === 2)
    }

    if (process.exitCode) console.error('\nsmoke-ask-user FAILED')
    else console.log('\n✓ smoke-ask-user passed')
}

void main()
