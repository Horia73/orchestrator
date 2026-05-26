"use client"

import * as React from "react"
import { ChevronDown, ListChecks } from "lucide-react"

import type { Message, ReasoningEntry, ToolCallReasoningEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

interface TodoItem {
    id: string
    content: string
    status: "pending" | "in_progress" | "completed"
    priority?: "low" | "medium" | "high"
}

export function TodoBar({
    messages,
    streamingReasoning,
    reasoning,
    storageKey = "todo-bar:expanded",
    hideCompleted = false,
}: {
    messages?: Message[]
    streamingReasoning?: ReasoningEntry[]
    reasoning?: ReasoningEntry[]
    storageKey?: string
    hideCompleted?: boolean
}) {
    const todos = React.useMemo(
        () => reasoning ? latestTodosFromReasoning(reasoning) : latestTodos(messages ?? [], streamingReasoning ?? []),
        [messages, reasoning, streamingReasoning]
    )
    const [expanded, setExpanded] = React.useState(() => {
        if (typeof window === "undefined") return true
        return window.localStorage.getItem(storageKey) !== "false"
    })

    React.useEffect(() => {
        window.localStorage.setItem(storageKey, String(expanded))
    }, [expanded, storageKey])

    if (!todos.length) return null

    const active = todos.filter(t => t.status === "in_progress").length
    const done = todos.filter(t => t.status === "completed").length
    const pending = todos.length - active - done
    if (hideCompleted && done === todos.length) return null

    return (
        <div className="mb-2 overflow-hidden rounded-md border border-border bg-background shadow-sm">
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/35"
            >
                <div className="flex min-w-0 items-center gap-2">
                    <ListChecks className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-[13px] font-medium text-foreground">
                        {todos.length} task{todos.length === 1 ? "" : "s"}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                        {active} active | {pending} pending | {done} done
                    </span>
                </div>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
            </button>
            {expanded && (
                <div className="max-h-[min(260px,calc(100vh-300px))] overflow-auto border-t border-border/70 px-3 py-2">
                    <ul className="space-y-1.5">
                        {todos.map(todo => (
                            <li key={todo.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2 text-[13px]">
                                <span className={cn(
                                    "mt-[3px] size-3.5 rounded-sm border",
                                    todo.status === "completed" && "border-emerald-500 bg-emerald-500",
                                    todo.status === "in_progress" && "border-blue-500 bg-blue-500/20",
                                    todo.status === "pending" && "border-muted-foreground/50"
                                )} />
                                <span className={cn(
                                    "min-w-0 break-words",
                                    todo.status === "completed" ? "text-muted-foreground line-through" : "text-foreground"
                                )}>
                                    {todo.content}
                                </span>
                                <span className={cn(
                                    "rounded px-1.5 py-0.5 text-[11px]",
                                    todo.status === "completed" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                                    todo.status === "in_progress" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
                                    todo.status === "pending" && "bg-muted text-muted-foreground"
                                )}>
                                    {todo.status.replace("_", " ")}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

function latestTodos(messages: Message[], streamingReasoning: ReasoningEntry[]): TodoItem[] {
    const entries: ToolCallReasoningEntry[] = []
    for (const message of messages) collectTodoEntries(message.reasoning, entries)
    collectTodoEntries(streamingReasoning, entries)
    return latestTodosFromEntries(entries)
}

function latestTodosFromReasoning(reasoning: ReasoningEntry[]): TodoItem[] {
    const entries: ToolCallReasoningEntry[] = []
    collectTodoEntries(reasoning, entries)
    return latestTodosFromEntries(entries)
}

function latestTodosFromEntries(entries: ToolCallReasoningEntry[]): TodoItem[] {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const todos = todosFromEntry(entries[i])
        if (todos.length) return todos
    }
    return []
}

function collectTodoEntries(reasoning: ReasoningEntry[] | undefined, out: ToolCallReasoningEntry[]) {
    if (!reasoning) return
    for (const entry of reasoning) {
        if (entry.type === "tool_call" && entry.toolName === "TodoWrite") out.push(entry)
    }
}

function todosFromEntry(entry: ToolCallReasoningEntry): TodoItem[] {
    const fromArgs = normalizeTodos(entry.args?.todos)
    if (fromArgs.length) return fromArgs
    const raw = entry.content.startsWith("Error: ") ? entry.content.slice(7) : entry.content
    try {
        const parsed = JSON.parse(raw) as { todos?: unknown }
        return normalizeTodos(parsed.todos)
    } catch {
        return []
    }
}

function normalizeTodos(input: unknown): TodoItem[] {
    if (!Array.isArray(input)) return []
    return input.flatMap((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        const content = typeof record.content === "string" ? record.content.trim() : ""
        if (!content) return []
        const status: TodoItem["status"] = record.status === "in_progress" || record.status === "completed" ? record.status : "pending"
        const priority: TodoItem["priority"] = record.priority === "low" || record.priority === "medium" || record.priority === "high"
            ? record.priority
            : undefined
        const todo: TodoItem = {
            id: typeof record.id === "string" && record.id ? record.id : `todo_${index + 1}`,
            content,
            status,
            priority,
        }
        return [todo]
    })
}
