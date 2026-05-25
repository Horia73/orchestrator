const SECRET_VALUE_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
    /\bwhsec_[A-Za-z0-9_-]{12,}\b/g,
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
];

const SECRET_ASSIGNMENT_PATTERN =
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization|bearer)\s*[:=]\s*([^\s,;]+)/gi;
const PASSWORD_PHRASE_PATTERN =
    /\b(password|passcode)\s+[`'"]([^`'"]+)[`'"]/gi;

const SENSITIVE_CONTEXT_PATTERN =
    /\b(password|passcode|credential|secret|token|bearer|authorization|api\s*key|webhook\s*secret)\b/i;

export function isLikelySensitiveBrowserText(value: string | undefined, context = ''): boolean {
    const text = String(value || '');
    if (!text) return false;
    if (SENSITIVE_CONTEXT_PATTERN.test(context)) return true;
    if (SECRET_ASSIGNMENT_PATTERN.test(text)) return true;
    SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
    if (PASSWORD_PHRASE_PATTERN.test(text)) return true;
    PASSWORD_PHRASE_PATTERN.lastIndex = 0;
    return SECRET_VALUE_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
    });
}

export function redactBrowserAgentText(value: string | undefined, context = ''): string {
    const text = String(value || '');
    if (!text) return '';
    if (SENSITIVE_CONTEXT_PATTERN.test(context)) return '[redacted]';

    let redacted = text
        .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]')
        .replace(PASSWORD_PHRASE_PATTERN, '$1 [redacted]');
    SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
    PASSWORD_PHRASE_PATTERN.lastIndex = 0;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        pattern.lastIndex = 0;
        redacted = redacted.replace(pattern, '[redacted]');
    }
    return redacted;
}

export function formatBrowserAgentTextForLog(value: string | undefined, context = '', maxChars = 80): string {
    const text = String(value || '');
    if (!text) return '';
    if (isLikelySensitiveBrowserText(text, context)) return '[redacted]';
    const clean = redactBrowserAgentText(text, context).replace(/\s+/g, ' ').trim();
    return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1).trimEnd()}...`;
}
