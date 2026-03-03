export const TODO_TOOL_NAME = 'manage_todo_list';

const VALID_TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked']);

export function isTodoToolName(value) {
    return String(value ?? '').trim() === TODO_TOOL_NAME;
}

export function normalizeTodoStatus(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return VALID_TODO_STATUSES.has(normalized) ? normalized : 'pending';
}

function normalizeTodoItem(rawItem, index) {
    if (!rawItem || typeof rawItem !== 'object') {
        return null;
    }

    const id = String(rawItem.id ?? `item-${index + 1}`).trim() || `item-${index + 1}`;
    const label = String(
        rawItem.label
        ?? rawItem.text
        ?? rawItem.title
        ?? '',
    ).trim();

    if (!label) {
        return null;
    }

    const details = String(rawItem.details ?? rawItem.note ?? '').trim();

    return {
        id,
        label,
        status: normalizeTodoStatus(rawItem.status),
        ...(details ? { details } : {}),
    };
}

function buildTodoSummary(items) {
    const summary = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        blocked: 0,
    };

    for (const item of items) {
        if (summary[item.status] !== undefined) {
            summary[item.status] += 1;
        }
    }

    return summary;
}

function normalizeTodoList(rawTodoList, fallback = {}) {
    const safeTodoList = rawTodoList && typeof rawTodoList === 'object' ? rawTodoList : {};
    const items = Array.isArray(safeTodoList.items)
        ? safeTodoList.items.map(normalizeTodoItem).filter(Boolean)
        : [];
    const updatedAt = Number(safeTodoList.updatedAt ?? fallback.updatedAt);

    return {
        title: String(safeTodoList.title ?? fallback.title ?? 'Current plan').trim() || 'Current plan',
        items,
        itemCount: items.length,
        summary: buildTodoSummary(items),
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
    };
}

export function formatTodoStatusLabel(status) {
    if (status === 'in_progress') return 'In progress';
    if (status === 'completed') return 'Completed';
    if (status === 'blocked') return 'Blocked';
    return 'Pending';
}

export function getTodoToolState({ functionCall, functionResponse } = {}) {
    const args = functionCall?.args && typeof functionCall.args === 'object'
        ? functionCall.args
        : {};
    const responseObject = functionResponse?.response && typeof functionResponse.response === 'object'
        ? functionResponse.response
        : null;
    const action = String(responseObject?.action ?? args?.action ?? '').trim().toLowerCase();
    const todoList = normalizeTodoList(
        responseObject?.todoList,
        {
            title: args?.title,
            items: args?.items,
        },
    );
    const message = String(responseObject?.message ?? '').trim();

    return {
        action,
        message,
        todoList,
        isCleared: action === 'clear' || todoList.itemCount === 0,
    };
}

export function extractLatestTodoState(messages) {
    const safeMessages = Array.isArray(messages) ? messages : [];

    for (let messageIndex = safeMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const parts = Array.isArray(safeMessages[messageIndex]?.parts)
            ? safeMessages[messageIndex].parts
            : [];

        for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = parts[partIndex];
            const functionResponse = part?.functionResponse;
            const responseName = String(functionResponse?.name ?? '').trim();
            if (!isTodoToolName(responseName)) {
                continue;
            }

            const todoState = getTodoToolState({
                functionResponse,
            });

            if (todoState.isCleared) {
                return null;
            }

            return todoState;
        }
    }

    return null;
}
