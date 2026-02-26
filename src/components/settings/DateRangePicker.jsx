import { useEffect, useMemo, useRef, useState } from 'react';
import {
    DATE_RANGE_PRESETS,
    getLocalDateKey,
    getPresetRange,
    normalizeRange,
    parseDateKey,
    toDateKey,
} from './dateRangeUtils.js';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
});
const BUTTON_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});

function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
}

function addMonths(date, delta) {
    return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12, 0, 0, 0);
}

function getCalendarCells(monthDate, selectedDateKey) {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const previousMonthDays = new Date(year, month, 0).getDate();

    const cells = [];

    for (let day = firstWeekday - 1; day >= 0; day -= 1) {
        const date = new Date(year, month - 1, previousMonthDays - day, 12, 0, 0, 0);
        const dateKey = toDateKey(date);
        cells.push({
            dateKey,
            day: date.getDate(),
            inCurrentMonth: false,
            isSelected: dateKey === selectedDateKey,
            isToday: dateKey === getLocalDateKey(),
        });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(year, month, day, 12, 0, 0, 0);
        const dateKey = toDateKey(date);
        cells.push({
            dateKey,
            day,
            inCurrentMonth: true,
            isSelected: dateKey === selectedDateKey,
            isToday: dateKey === getLocalDateKey(),
        });
    }

    const remaining = (7 - (cells.length % 7)) % 7;
    for (let day = 1; day <= remaining; day += 1) {
        const date = new Date(year, month + 1, day, 12, 0, 0, 0);
        const dateKey = toDateKey(date);
        cells.push({
            dateKey,
            day,
            inCurrentMonth: false,
            isSelected: dateKey === selectedDateKey,
            isToday: dateKey === getLocalDateKey(),
        });
    }

    return cells;
}

function CalendarDatePicker({ label, dateKey, onChange }) {
    const rootRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(parseDateKey(dateKey)));

    useEffect(() => {
        setVisibleMonth(startOfMonth(parseDateKey(dateKey)));
    }, [dateKey]);

    useEffect(() => {
        if (!open) return undefined;

        const handleOutsideClick = (event) => {
            if (rootRef.current && !rootRef.current.contains(event.target)) {
                setOpen(false);
            }
        };

        const handleEscape = (event) => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', handleOutsideClick);
        document.addEventListener('keydown', handleEscape);

        return () => {
            document.removeEventListener('mousedown', handleOutsideClick);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [open]);

    const monthLabel = MONTH_LABEL_FORMATTER.format(visibleMonth);
    const calendarCells = useMemo(
        () => getCalendarCells(visibleMonth, dateKey),
        [visibleMonth, dateKey],
    );
    const buttonLabel = BUTTON_DATE_FORMATTER.format(parseDateKey(dateKey));

    return (
        <div className="usage-date-picker" ref={rootRef}>
            <span>{label}</span>
            <button
                type="button"
                className={`usage-date-trigger${open ? ' open' : ''}`}
                onClick={() => setOpen((current) => !current)}
                aria-expanded={open}
                aria-haspopup="dialog"
            >
                <span>{buttonLabel}</span>
                <span className="usage-date-trigger-caret">▾</span>
            </button>

            {open && (
                <div className="usage-calendar-popover" role="dialog" aria-label={`Select ${label}`}>
                    <div className="usage-calendar-header">
                        <button type="button" onClick={() => setVisibleMonth((current) => addMonths(current, -1))}>
                            ‹
                        </button>
                        <strong>{monthLabel}</strong>
                        <button type="button" onClick={() => setVisibleMonth((current) => addMonths(current, 1))}>
                            ›
                        </button>
                    </div>

                    <div className="usage-calendar-grid usage-calendar-weekdays">
                        {WEEKDAY_LABELS.map((weekdayLabel) => (
                            <span key={weekdayLabel}>{weekdayLabel}</span>
                        ))}
                    </div>

                    <div className="usage-calendar-grid usage-calendar-days">
                        {calendarCells.map((cell) => (
                            <button
                                key={cell.dateKey}
                                type="button"
                                className={`usage-calendar-day${cell.inCurrentMonth ? '' : ' muted'}${cell.isSelected ? ' selected' : ''}${cell.isToday ? ' today' : ''}`}
                                onClick={() => {
                                    onChange(cell.dateKey);
                                    setOpen(false);
                                }}
                            >
                                {cell.day}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export function DateRangePicker({ value, onChange }) {
    const normalized = normalizeRange(value);
    const preset = String(normalized.preset ?? 'today').trim();

    const applyPreset = (nextPreset) => {
        if (nextPreset === 'custom') {
            onChange({
                preset: 'custom',
                startDate: normalized.startDate,
                endDate: normalized.endDate,
            });
            return;
        }

        onChange(getPresetRange(nextPreset));
    };

    const applyCustomDate = (key, nextDateKey) => {
        const nextRange = normalizeRange({
            preset: 'custom',
            startDate: key === 'startDate' ? nextDateKey : normalized.startDate,
            endDate: key === 'endDate' ? nextDateKey : normalized.endDate,
        });
        onChange(nextRange);
    };

    return (
        <div className="range-picker-shell">
            <div className="range-preset-row">
                {DATE_RANGE_PRESETS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={`range-preset-btn${preset === item.id ? ' active' : ''}`}
                        onClick={() => applyPreset(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            {preset === 'custom' && (
                <div className="range-custom-row">
                    <CalendarDatePicker
                        label="From"
                        dateKey={normalized.startDate}
                        onChange={(dateKey) => applyCustomDate('startDate', dateKey)}
                    />
                    <CalendarDatePicker
                        label="To"
                        dateKey={normalized.endDate}
                        onChange={(dateKey) => applyCustomDate('endDate', dateKey)}
                    />
                </div>
            )}
        </div>
    );
}
