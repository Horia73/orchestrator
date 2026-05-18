import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { ensureParentDir } from './helpers'

const TODO_DIR = path.join(process.cwd(), '.orchestrator', 'todos')

export const todoWriteTool: ToolDef = {
    id: 'TodoWrite',
    name: 'TodoWrite',
    description: 'Persists the agent todo list for the current chat. Send the complete current list each time.',
    input_schema: {
        type: 'object',
        properties: {
            todos: {
                type: 'array',
                description: 'Complete todo list for this chat.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Stable todo id.' },
                        content: { type: 'string', description: 'Todo text.' },
                        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current todo status.' },
                        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional priority.' },
                    },
                    required: ['id', 'content', 'status'],
                },
            },
        },
        required: ['todos'],
    },
    tags: ['write', 'task_tracking'],
}

export function executeTodoWrite(args: Record<string, unknown>, ctx?: ToolExecutionContext): ToolResult {
    if (!ctx?.conversationId) {
        return { success: false, error: 'TodoWrite requires a conversation context.' }
    }
    if (!Array.isArray(args.todos)) {
        return { success: false, error: 'Missing required array parameter: todos' }
    }

    const todos = args.todos.map((item, index) => normalizeTodo(item, index))
    const invalid = todos.find(todo => todo.error)
    if (invalid?.error) return { success: false, error: invalid.error }

    const filePath = path.join(TODO_DIR, `${safeFileName(ctx.conversationId)}.json`)
    try {
        ensureParentDir(filePath)
        fs.writeFileSync(filePath, JSON.stringify({
            conversationId: ctx.conversationId,
            updatedAt: Date.now(),
            todos: todos.map(stripError),
        }, null, 2), 'utf-8')

        return {
            success: true,
            data: {
                conversationId: ctx.conversationId,
                todos: todos.map(stripError),
                count: todos.length,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error writing todos' }
    }
}

interface NormalizedTodo {
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    priority?: 'low' | 'medium' | 'high'
    error?: string
}

function normalizeTodo(item: unknown, index: number): NormalizedTodo {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { id: '', content: '', status: 'pending', error: `todos[${index}] must be an object` }
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `todo_${index + 1}`
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (!content) return { id, content, status: 'pending', error: `todos[${index}].content must be a non-empty string` }
    const status = normalizeStatus(record.status)
    if (!status) return { id, content, status: 'pending', error: `todos[${index}].status must be pending, in_progress, or completed` }
    const priority = normalizePriority(record.priority)
    return { id, content, status, ...(priority ? { priority } : {}) }
}

function stripError(todo: NormalizedTodo): Omit<NormalizedTodo, 'error'> {
    return {
        id: todo.id,
        content: todo.content,
        status: todo.status,
        ...(todo.priority ? { priority: todo.priority } : {}),
    }
}

function normalizeStatus(value: unknown): NormalizedTodo['status'] | null {
    if (value === 'pending' || value === 'in_progress' || value === 'completed') return value
    return null
}

function normalizePriority(value: unknown): NormalizedTodo['priority'] | null {
    if (value === 'low' || value === 'medium' || value === 'high') return value
    return null
}

function safeFileName(input: string): string {
    return input.replace(/[^a-zA-Z0-9_.-]/g, '_')
}
