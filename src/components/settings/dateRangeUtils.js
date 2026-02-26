export const DATE_RANGE_PRESETS = [
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'This Week' },
    { id: 'month', label: 'This Month' },
    { id: 'year', label: 'This Year' },
    { id: 'custom', label: 'Custom' },
];

function pad2(value) {
    return String(value).padStart(2, '0');
}

export function toDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDateKey(dateKey) {
    const normalized = String(dateKey ?? '').trim();
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return new Date();
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function getLocalDateKey(date = new Date()) {
    return toDateKey(date);
}

export function getPresetRange(preset, baseDateKey = getLocalDateKey()) {
    const baseDate = parseDateKey(baseDateKey);

    if (preset === 'week') {
        const weekday = baseDate.getDay();
        const start = new Date(baseDate);
        start.setDate(baseDate.getDate() - weekday);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return {
            preset,
            startDate: toDateKey(start),
            endDate: toDateKey(end),
        };
    }

    if (preset === 'month') {
        const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1, 12, 0, 0, 0);
        const end = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0, 12, 0, 0, 0);
        return {
            preset,
            startDate: toDateKey(start),
            endDate: toDateKey(end),
        };
    }

    if (preset === 'year') {
        const start = new Date(baseDate.getFullYear(), 0, 1, 12, 0, 0, 0);
        const end = new Date(baseDate.getFullYear(), 11, 31, 12, 0, 0, 0);
        return {
            preset,
            startDate: toDateKey(start),
            endDate: toDateKey(end),
        };
    }

    if (preset === 'custom') {
        return {
            preset,
            startDate: baseDateKey,
            endDate: baseDateKey,
        };
    }

    return {
        preset: 'today',
        startDate: baseDateKey,
        endDate: baseDateKey,
    };
}

export function normalizeRange(range) {
    const startDate = String(range?.startDate ?? '').trim() || getLocalDateKey();
    const endDate = String(range?.endDate ?? '').trim() || startDate;

    if (startDate <= endDate) {
        return {
            ...range,
            startDate,
            endDate,
        };
    }

    return {
        ...range,
        startDate: endDate,
        endDate: startDate,
    };
}

export function isDateWithinRange(dateKey, startDate, endDate) {
    const date = String(dateKey ?? '').trim();
    const start = String(startDate ?? '').trim();
    const end = String(endDate ?? '').trim();
    if (!date || !start || !end) {
        return false;
    }

    return date >= start && date <= end;
}
