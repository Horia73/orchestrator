"use client"

import * as React from "react"
import { AlertTriangle, Check, CornerDownLeft, HelpCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import {
    parseQuestionArtifact,
    type QuestionAnswer,
    type QuestionArtifact,
} from "@/lib/questions/schema"
import { useChatStoreOptional } from "@/hooks/use-chat-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import { useConversationArtifacts } from "../use-conversation-artifacts"

/**
 * Renderer for `application/vnd.ant.question` — the tappable question card the
 * orchestrator poses via the `ask_user` tool.
 *
 * Interaction model (see lib/ai/tools/ask-user.ts):
 *   - single-select: tapping an option submits it immediately;
 *   - multi-select: options toggle, a Confirm button submits the set;
 *   - allowOther: a free-text field lets the user answer off-menu.
 *
 * Submitting does two things: (1) POSTs the choice to /api/artifacts/:id/answer
 * so the card is persisted as answered (a reload shows the locked, resolved
 * state and it can't be answered twice), and (2) posts the chosen value as the
 * user's next chat message via the chat store — that is what continues the
 * agent turn. Once answered, the card renders read-only with the selection
 * highlighted; the user's own message bubble below shows what they picked.
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

    const multiSelect = question.multiSelect === true
    const allowOther = question.allowOther === true

    const [answer, setAnswer] = React.useState<QuestionAnswer | null>(question.answered ?? null)
    const [selected, setSelected] = React.useState<Set<string>>(new Set())
    const [otherOpen, setOtherOpen] = React.useState(false)
    const [otherText, setOtherText] = React.useState("")
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

    const submit = React.useCallback(
        async (chosenLabels: string[], freeText?: string) => {
            if (submittingRef.current || answer) return
            const cleanOther = freeText?.trim() ? freeText.trim() : undefined
            const labels = chosenLabels.filter(Boolean)
            if (labels.length === 0 && !cleanOther) return
            if (!artifact.conversationId || typeof chat?.sendMessageToConversation !== "function") return

            submittingRef.current = true
            setSubmitting(true)

            const optimistic: QuestionAnswer = {
                selected: labels,
                ...(cleanOther ? { other: cleanOther } : {}),
                answeredAt: new Date().toISOString(),
            }
            setAnswer(optimistic)

            const messageText = [...labels, ...(cleanOther ? [cleanOther] : [])].join(", ")

            // Persist the answered state onto the card (best-effort). The chat
            // message below is what actually continues the turn, so a persistence
            // miss degrades to "interactive again after reload", never a lost turn.
            void fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/answer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ selected: labels, ...(cleanOther ? { other: cleanOther } : {}) }),
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
        },
        [answer, artifact.conversationId, artifact.id, chat, addArtifact],
    )

    const toggle = (label: string) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(label)) next.delete(label)
            else next.add(label)
            return next
        })
    }

    const confirmMulti = () => {
        void submit([...selected], otherOpen ? otherText : undefined)
    }

    // ── Answered (locked) state ──────────────────────────────────────────
    if (answer) {
        const chosen = new Set(answer.selected)
        return (
            <div
                className={cn(
                    "flex w-full min-w-0 max-w-full flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/15 p-3.5 text-foreground",
                    className,
                )}
                aria-label={`Answered: ${question.question}`}
            >
                <QuestionHeader question={question} />
                <div className="flex flex-col gap-1.5">
                    {question.options.map((opt) => {
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
                                <span
                                    className={cn(
                                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                                        isChosen ? "border-primary bg-primary text-primary-foreground" : "border-border",
                                    )}
                                >
                                    {isChosen ? <Check className="size-3" /> : null}
                                </span>
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
                </div>
                {answer.other ? (
                    <div className="flex items-start gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2 text-sm">
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground">
                            <Check className="size-3" />
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words font-medium">{answer.other}</span>
                    </div>
                ) : null}
                <p className="text-[12px] text-muted-foreground/70">Answered</p>
            </div>
        )
    }

    // ── Interactive state ────────────────────────────────────────────────
    return (
        <div
            className={cn(
                "flex w-full min-w-0 max-w-full flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-3.5 text-foreground",
                className,
            )}
            aria-label={question.question}
        >
            <QuestionHeader question={question} />

            <div className="flex flex-col gap-1.5">
                {question.options.map((opt) => {
                    const isChecked = selected.has(opt.label)
                    return (
                        <button
                            key={opt.label}
                            type="button"
                            disabled={!canInteract}
                            aria-pressed={multiSelect ? isChecked : undefined}
                            onClick={() => {
                                if (!canInteract) return
                                if (multiSelect) toggle(opt.label)
                                else void submit([opt.label])
                            }}
                            className={cn(
                                "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                                "disabled:cursor-default disabled:opacity-60",
                                isChecked
                                    ? "border-primary/60 bg-primary/10"
                                    : "border-border/70 bg-background/40 enabled:hover:border-border enabled:hover:bg-muted/50",
                            )}
                        >
                            <span
                                className={cn(
                                    "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                                    multiSelect ? "rounded" : "rounded-full",
                                    isChecked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                                )}
                            >
                                {isChecked ? <Check className="size-3" /> : null}
                            </span>
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
                    open={otherOpen}
                    text={otherText}
                    disabled={!canInteract}
                    multiSelect={multiSelect}
                    onOpen={() => setOtherOpen(true)}
                    onChange={setOtherText}
                    onSubmitSingle={() => void submit([], otherText)}
                />
            ) : null}

            {multiSelect ? (
                <div className="flex items-center justify-end pt-0.5">
                    <Button
                        type="button"
                        size="sm"
                        disabled={!canInteract || (selected.size === 0 && !(otherOpen && otherText.trim()))}
                        onClick={confirmMulti}
                    >
                        {submitting ? "Sending…" : "Confirm"}
                    </Button>
                </div>
            ) : null}
        </div>
    )
}

function QuestionHeader({ question }: { question: QuestionArtifact }) {
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
    multiSelect,
    onOpen,
    onChange,
    onSubmitSingle,
}: {
    open: boolean
    text: string
    disabled: boolean
    multiSelect: boolean
    onOpen: () => void
    onChange: (value: string) => void
    onSubmitSingle: () => void
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
        <div className="flex items-center gap-2">
            <Input
                autoFocus
                value={text}
                disabled={disabled}
                placeholder="Type your answer…"
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (!multiSelect && e.key === "Enter" && text.trim() && !disabled) {
                        e.preventDefault()
                        onSubmitSingle()
                    }
                }}
                className="h-9"
            />
            {!multiSelect ? (
                <Button
                    type="button"
                    size="icon"
                    disabled={disabled || !text.trim()}
                    onClick={onSubmitSingle}
                    aria-label="Send answer"
                >
                    <CornerDownLeft className="size-4" />
                </Button>
            ) : null}
        </div>
    )
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
