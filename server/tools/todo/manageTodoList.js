import { getExecutionContext } from '../../core/context.js';
import {
    clearTodoState,
    getTodoState,
    replaceTodoState,
} from '../../storage/todos.js';

const TODO_TITLE_FALLBACK = 'Current plan';

export const declaration = {
    name: 'manage_todo_list',
    description: 'Get, replace, or clear the current chat to-do list so the UI can show live task progress.',
    parameters: {
        type: 'OBJECT',
        properties: {
            action: {
                type: 'STRING',
                description: 'Todo action to perform.',
                enum: ['get', 'replace', 'clear'],
            },
            title: {
                type: 'STRING',
                description: 'Optional short title shown above the to-do list in the UI.',
            },
            items: {
                type: 'ARRAY',
                description: 'Full list of todo items when action is "replace".',
                items: {
                    type: 'OBJECT',
                    properties: {
                        id: {
                            type: 'STRING',
                            description: 'Stable item identifier. Optional but recommended when updating an existing list.',
                        },
                        label: {
                            type: 'STRING',
                            description: 'Short task label shown in the UI.',
                        },
                        status: {
                            type: 'STRING',
                            description: 'Task state.',
                            enum: ['pending', 'in_progress', 'completed', 'blocked'],
                        },
                        details: {
                            type: 'STRING',
                            description: 'Optional extra detail or blocker note.',
                        },
                    },
                    required: ['label'],
                },
            },
        },
        required: ['action'],
    },
};

function buildMessage(action, todoList) {
    if (action === 'get') {
        return todoList.itemCount > 0
            ? `Loaded ${todoList.itemCount} todo item${todoList.itemCount === 1 ? '' : 's'}.`
            : 'Todo list is empty.';
    }

    if (action === 'clear') {
        return 'Cleared todo list.';
    }

    return `Updated todo list with ${todoList.itemCount} item${todoList.itemCount === 1 ? '' : 's'}.`;
}

export async function execute(args) {
    const context = getExecutionContext();
    const chatId = String(context?.chatId ?? '').trim();
    if (!chatId) {
        return { error: 'manage_todo_list requires an active chat context.' };
    }

    const action = String(args?.action ?? '').trim().toLowerCase();
    const title = String(args?.title ?? '').trim() || TODO_TITLE_FALLBACK;

    try {
        if (action === 'get') {
            const todoList = await getTodoState(chatId, { fallbackTitle: title });
            return {
                ok: true,
                action,
                todoList,
                message: buildMessage(action, todoList),
            };
        }

        if (action === 'replace') {
            if (!Array.isArray(args?.items)) {
                return { error: 'items array is required when action is "replace".' };
            }

            const todoList = await replaceTodoState(chatId, {
                title,
                items: args.items,
            }, {
                fallbackTitle: title,
            });

            return {
                ok: true,
                action,
                todoList,
                message: buildMessage(action, todoList),
            };
        }

        if (action === 'clear') {
            const todoList = await clearTodoState(chatId, { fallbackTitle: title });
            return {
                ok: true,
                action,
                todoList,
                message: buildMessage(action, todoList),
            };
        }

        return { error: 'Unknown action. Use "get", "replace", or "clear".' };
    } catch (error) {
        return {
            error: `Failed to manage todo list: ${error.message}`,
        };
    }
}
