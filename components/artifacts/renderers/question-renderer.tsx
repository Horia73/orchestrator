"use client"

import * as React from "react"
import { AlertTriangle, Check, HelpCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import {
    parseQuestionArtifact,
    type QuestionAnswer,
    type QuestionArtifact,
    type QuestionItem,
} from "@/lib/questions/schema"
import { useChatStoreOptional } from "@/hooks/use-chat-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import { useConversationArtifacts } from "../use-conversation-artifacts"

/**
 * Renderer for `application/vnd.ant.question` — the tappable question card the
 * orchestrator poses via the `ask_user` tool. A card carries 1–4 questions.
 *
 * Interaction model (see lib/ai/tools/ask-user.ts):
 *   - each question shows single-select (radio) or multi-select (checkbox)
 *     options that toggle on tap — nothing sends on tap;
 *   - allowOther adds a free-text field per question;
 *   - a single "Send" button at the bottom submits every answer at once, and is
 *     enabled only once every question has an answer.
 *
 * Submitting does two things: (1) POSTs the responses to
 * /api/artifacts/:id/answer so the card is persisted as answered (a reload shows
 * the locked, resolved state and it can't be answered twice), and (2) posts the
 * chosen values as the user's next chat message via the chat store — that is
 * what continues the agent turn. Once answered, the card renders read-only with
 * the selections highlighted.
 *
 * In provider-less preview contexts (no chat store) the card renders read-only.
 * Malformed JSON / schema violations render a styled error card.
 */
export function QuestionRenderer({
    artifact,
    className,
}: {
    artifact: ArtifactRow
    className?: string
}) {
    const parsed = React.useMemo(() => parseQuestionArtifact(artifact.content), [artifact.content])

    if (!parsed.ok) {
        return <QuestionErrorCard message={parsed.error} className={className} />
    }
    return <QuestionCard artifact={artifact} question={parsed.value} className={className} />
}

/** Per-question interactive state (index-aligned to question.questions). */
type DraftResponse = {
    selected: Set<string>
    otherOpen: boolean
    otherText: string
}

function emptyDrafts(questions: QuestionItem[]): DraftResponse[] {
    return questions.map(() => ({ selected: new Set<string>(), otherOpen: false, otherText: "" }))
}

/** A question is answerable-complete when it has a picked option or Other text. */
function isDraftAnswered(d: DraftResponse): boolean {
    return d.selected.size > 0 || (d.otherOpen && d.otherText.trim().length > 0)
}

function QuestionCard({
    artifact,
    question,
    className,
}: {
    artifact: ArtifactRow
    question: QuestionArtifact
    className?: string
}) {
    const chat = useChatStoreOptional()
    const { addArtifact } = useConversationArtifacts()

    const questions = question.questions

    const [answer, setAnswer] = React.useState<QuestionAnswer | null>(question.answered ?? null)
    const [drafts, setDrafts] = React.useState<DraftResponse[]>(() => emptyDrafts(questions))
    const submittingRef = React.useRef(false)
    const [submitting, setSubmitting] = React.useState(false)

    // Adopt a late-arriving persisted answer (e.g. the store reconciles after a
    // foreground refetch) so the card locks even if it was answered elsewhere.
    React.useEffect(() => {
        if (question.answered && !answer) setAnswer(question.answered)
    }, [question.answered, answer])

    const canInteract =
        !answer &&
        !submitting &&
        Boolean(artifact.conversationId) &&
        typeof chat?.sendMessageToConversation === "function"

    const allAnswered = drafts.length === questions.length && drafts.every(isDraftAnswered)

    const updateDraft = React.useCallback((index: number, patch: (prev: DraftResponse) => DraftResponse) => {
        setDrafts((prev) => prev.map((d, i) => (i === index ? patch(d) : d)))
    }, [])

    const toggleOption = React.useCallback(
        (index: number, label: string, multiSelect: boolean) => {
            if (!canInteract) return
            updateDraft(index, (prev) => {
                if (multiSelect) {
                    const next = new Set(prev.selected)
                    if (next.has(label)) next.delete(label)
                    else next.add(label)
                    return { ...prev, selected: next }
                }
                // Single-select behaves like a radio group: picking an option
                // replaces any prior pick and clears this question's Other.
                return { selected: new Set([label]), otherOpen: false, otherText: "" }
            })
        },
        [canInteract, updateDraft],
    )

    const openOther = React.useCallback(
        (index: number, multiSelect: boolean) => {
            if (!canInteract) return
            updateDraft(index, (prev) => ({
                // For single-select, Other is one of the mutually-exclusive picks.
                selected: multiSelect ? prev.selected : new Set<string>(),
                otherOpen: true,
                otherText: prev.otherText,
            }))
        },
        [canInteract, updateDraft],
    )

    const changeOther = React.useCallback(
        (index: number, text: string) => {
            updateDraft(index, (prev) => ({ ...prev, otherText: text }))
        },
        [updateDraft],
    )

    const submit = React.useCallback(async () => {
        if (submittingRef.current || answer) return
        if (!artifact.conversationId || typeof chat?.sendMessageToConversation !== "function") return
        if (!allAnswered) return

        const responses = drafts.map((d) => {
            const other = d.otherOpen && d.otherText.trim() ? d.otherText.trim() : undefined
            return { selected: [...d.selected], ...(other ? { other } : {}) }
        })

        submittingRef.current = true
        setSubmitting(true)

        const optimistic: QuestionAnswer = {
            responses: responses.map((r) => ({ selected: r.selected, ...(r.other ? { other: r.other } : {}) })),
            answeredAt: new Date().toISOString(),
        }
        setAnswer(optimistic)

        const messageText = formatAnswerMessage(questions, responses)

        // Persist the answered state onto the card (best-effort). The chat
        // message below is what actually continues the turn, so a persistence
        // miss degrades to "interactive again after reload", never a lost turn.
        void fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ responses }),
        })
            .then(async (res) => {
                if (!res.ok) return
                const row = (await res.json()) as ArtifactRow
                if (row && typeof row === "object" && row.id) addArtifact(row)
            })
            .catch(() => {
                /* best-effort persistence */
            })

        try {
            await chat.sendMessageToConversation(artifact.conversationId, messageText)
        } finally {
            setSubmitting(false)
            submittingRef.current = false
        }
    }, [answer, allAnswered, artifact.conversationId, artifact.id, chat, addArtifact, drafts, questions])

    // ── Answered (locked) state ──────────────────────────────────────────
    if (answer) {
        return (
            <div
                className={cn(
                    "flex w-full min-w-0 max-w-full flex-col gap-4 rounded-xl border border-border/60 bg-muted/15 p-3.5 text-foreground",
                    className,
                )}
                aria-label={`Answered: ${questions.map((q) => q.question).join(" · ")}`}
            >
                {questions.map((q, qi) => {
                    const response = answer.responses[qi]
                    const chosen = new Set(response?.selected ?? [])
                    return (
                        <div key={qi} className="flex flex-col gap-2.5">
                            <QuestionHeader question={q} />
                            <div className="flex flex-col gap-1.5">
                                {q.options.map((opt) => {
                                    const isChosen = chosen.has(opt.label)
                                    return (
                                        <div
                                            key={opt.label}
                                            className={cn(
                                                "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                                                isChosen
                                                    ? "border-primary/50 bg-primary/10 text-foreground"
                                                    : "border-transparent text-muted-foreground/70",
                                            )}
                                        >
                                            <SelectionDot checked={isChosen} multiSelect={q.multiSelect === true} />
                                            <span className="min-w-0">
                                                <span className={cn(isChosen && "font-medium")}>{opt.label}</span>
                                                {opt.description ? (
                                                    <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground/70">
                                                        {opt.description}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </div>
                                    )
                                })}
                                {response?.other ? (
                                    <div className="flex items-start gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2 text-sm">
                                        <SelectionDot checked multiSelect={q.multiSelect === true} />
                                        <span className="min-w-0 whitespace-pre-wrap break-words font-medium">
                                            {response.other}
                                        </span>
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )
                })}
                <p className="text-[12px] text-muted-foreground/70">Answered</p>
            </div>
        )
    }

    // ── Interactive state ────────────────────────────────────────────────
    return (
        <div
            className={cn(
                "flex w-full min-w-0 max-w-full flex-col gap-4 rounded-xl border border-border/70 bg-muted/20 p-3.5 text-foreground",
                className,
            )}
            aria-label={questions.map((q) => q.question).join(" · ")}
        >
            {questions.map((q, qi) => {
                const draft = drafts[qi]
                const multiSelect = q.multiSelect === true
                const allowOther = q.allowOther === true
                return (
                    <div key={qi} className="flex flex-col gap-2.5">
                        <QuestionHeader question={q} />

                        <div className="flex flex-col gap-1.5">
                            {q.options.map((opt) => {
                                const isChecked = draft.selected.has(opt.label)
                                return (
                                    <button
                                        key={opt.label}
                                        type="button"
                                        disabled={!canInteract}
                                        aria-pressed={multiSelect ? isChecked : undefined}
                                        onClick={() => toggleOption(qi, opt.label, multiSelect)}
                                        className={cn(
                                            "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                                            "disabled:cursor-default disabled:opacity-60",
                                            isChecked
                                                ? "border-primary/60 bg-primary/10"
                                                : "border-border/70 bg-background/40 enabled:hover:border-border enabled:hover:bg-muted/50",
                                        )}
                                    >
                                        <SelectionDot checked={isChecked} multiSelect={multiSelect} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block font-medium">{opt.label}</span>
                                            {opt.description ? (
                                                <span className="mt-0.5 block text-[12px] leading-5 text-muted-foreground">
                                                    {opt.description}
                                                </span>
                                            ) : null}
                                        </span>
                                    </button>
                                )
                            })}
                        </div>

                        {allowOther ? (
                            <OtherField
                                open={draft.otherOpen}
                                text={draft.otherText}
                                disabled={!canInteract}
                                onOpen={() => openOther(qi, multiSelect)}
                                onChange={(text) => changeOther(qi, text)}
                            />
                        ) : null}
                    </div>
                )
            })}

            <div className="flex items-center justify-end pt-0.5">
                <Button type="button" size="sm" disabled={!canInteract || !allAnswered} onClick={() => void submit()}>
                    {submitting ? "Sending…" : "Send"}
                </Button>
            </div>
        </div>
    )
}

function SelectionDot({ checked, multiSelect }: { checked: boolean; multiSelect: boolean }) {
    return (
        <span
            className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                multiSelect ? "rounded" : "rounded-full",
                checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
            )}
        >
            {checked ? <Check className="size-3" /> : null}
        </span>
    )
}

function QuestionHeader({ question }: { question: QuestionItem }) {
    return (
        <div className="flex flex-col gap-1.5">
            {question.header ? (
                <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <HelpCircle className="size-3" />
                    {question.header}
                </span>
            ) : null}
            <p className="text-sm font-medium leading-6 text-foreground">{question.question}</p>
        </div>
    )
}

function OtherField({
    open,
    text,
    disabled,
    onOpen,
    onChange,
}: {
    open: boolean
    text: string
    disabled: boolean
    onOpen: () => void
    onChange: (value: string) => void
}) {
    if (!open) {
        return (
            <button
                type="button"
                disabled={disabled}
                onClick={onOpen}
                className={cn(
                    "w-full rounded-lg border border-dashed border-border/70 bg-background/30 px-3 py-2 text-left text-sm text-muted-foreground transition-colors",
                    "disabled:cursor-default disabled:opacity-60 enabled:hover:border-border enabled:hover:text-foreground",
                )}
            >
                Something else…
            </button>
        )
    }
    return (
        <Input
            autoFocus
            value={text}
            disabled={disabled}
            placeholder="Type your answer…"
            onChange={(e) => onChange(e.target.value)}
            className="h-9"
        />
    )
}

/**
 * Format the user's selections into the chat message that continues the turn.
 * One question → just the chosen values. Multiple → one line per question,
 * prefixed by its header (or question text) so the agent can map answers back.
 */
function formatAnswerMessage(
    questions: QuestionItem[],
    responses: { selected: string[]; other?: string }[],
): string {
    const lines = questions.map((q, qi) => {
        const r = responses[qi]
        const parts = [...(r?.selected ?? []), ...(r?.other ? [r.other] : [])]
        const answerText = parts.join(", ")
        if (questions.length === 1) return answerText
        const key = (q.header?.trim() || q.question.trim()).replace(/\s+/g, " ")
        return `${key}: ${answerText}`
    })
    return lines.join("\n")
}

function QuestionErrorCard({ message, className }: { message: string; className?: string }) {
    return (
        <div
            className={cn(
                "flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 text-sm text-foreground",
                className,
            )}
        >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
                <p className="font-medium">Could not display this question</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{message}</p>
            </div>
        </div>
    )
}
