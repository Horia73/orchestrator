/**
 * AI System Prompts for Browser Automation
 * Focus: reliable web execution, tab hygiene, anti-spam behavior, and safe finalization.
 */

function formatLearnings(learnings) {
    if (!Array.isArray(learnings) || learnings.length === 0) {
        return '';
    }

    return `\n## Learned from Past Sessions:\n${learnings.map((item, index) => `${index + 1}. ${item}`).join('\n')}`;
}

function sanitizeUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }

    if (text.length > 180) {
        return `${text.slice(0, 177)}...`;
    }

    return text;
}

function normalizeTabCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return 0;
    }

    return Math.trunc(numeric);
}

function buildPageContextBlock(pageContext = {}) {
    const currentUrl = sanitizeUrl(pageContext.currentUrl);
    const openTabs = normalizeTabCount(pageContext.openTabs);
    const availableUploads = Array.isArray(pageContext.availableUploads) ? pageContext.availableUploads : [];
    const tabHint = openTabs > 1
        ? 'Multiple tabs are open. Be strict about tab relevance and close unrelated tabs.'
        : 'Single-tab mode currently.';
    const uploadHint = availableUploads.length > 0
        ? availableUploads
            .slice(0, 8)
            .map((file, index) => `- [${String(file?.id ?? `upload-${index + 1}`).trim()}] ${String(file?.name ?? 'file').trim()} (${String(file?.mimeType ?? 'application/octet-stream').trim()})`)
            .join('\n')
        : '- none';

    return [
        '## Current Browser Context',
        `Current URL: ${currentUrl || '(unknown)'}`,
        `Open Tabs: ${openTabs}`,
        `Tab Hint: ${tabHint}`,
        'Available Upload Files (use id or name in upload action):',
        uploadHint,
    ].join('\n');
}

function describeActionHistory(actionHistory) {
    const recentActions = Array.isArray(actionHistory) ? actionHistory.slice(-18) : [];
    if (recentActions.length === 0) {
        return '## Recent Actions\nNo previous actions in this run.';
    }

    const lines = recentActions.map((action, index) => {
        const step = index + 1;
        const actionName = String(action?.action ?? 'unknown').toUpperCase();
        const coord = Array.isArray(action?.coordinate)
            ? `[${action.coordinate[0]}, ${action.coordinate[1]}]`
            : '';
        const successMark = action?.success === false ? '✗' : '✓';
        const text = String(action?.text ?? '').trim();
        const beforeUrl = sanitizeUrl(action?.beforeUrl);
        const afterUrl = sanitizeUrl(action?.afterUrl);
        const beforeTabs = normalizeTabCount(action?.beforeTabs);
        const afterTabs = normalizeTabCount(action?.afterTabs);
        const tabDelta = Number(action?.tabDelta) || 0;
        const urlChanged = action?.urlChanged === true ? 'url_changed' : 'url_same';

        let line = `${step}. ${actionName}${coord ? ` @ ${coord}` : ''} ${successMark}`;
        if (text) {
            line += ` | text="${text.slice(0, 48)}"`;
        }
        if (beforeUrl || afterUrl) {
            line += ` | ${beforeUrl || '(unknown)'} -> ${afterUrl || '(unknown)'}`;
        }
        line += ` | tabs ${beforeTabs} -> ${afterTabs}`;
        if (tabDelta !== 0) {
            line += ` (delta ${tabDelta > 0 ? '+' : ''}${tabDelta})`;
        }
        line += ` | ${urlChanged}`;

        const reasoning = String(action?.reasoning ?? '').trim();
        if (reasoning) {
            line += `\n   reason: ${reasoning.slice(0, 120)}`;
        }

        return line;
    });

    return `## Recent Actions\n${lines.join('\n')}`;
}

function buildLoopWarnings(actionHistory) {
    const recentActions = Array.isArray(actionHistory) ? actionHistory.slice(-6) : [];
    const warnings = [];

    if (recentActions.length >= 4) {
        const last4 = recentActions.slice(-4);
        const coords = last4
            .map((item) => Array.isArray(item?.coordinate) ? `${item.coordinate[0]},${item.coordinate[1]}` : '')
            .filter(Boolean);
        if (coords.length === 4 && coords[0] === coords[2] && coords[1] === coords[3] && coords[0] !== coords[1]) {
            warnings.push('- Coordinate loop detected: alternating between the same spots. Try a different strategy.');
        }
    }

    if (recentActions.length >= 3) {
        const tabDeltas = recentActions.map((item) => Number(item?.tabDelta) || 0);
        const repeatedlyOpeningTabs = tabDeltas.filter((value) => value > 0).length >= 2;
        if (repeatedlyOpeningTabs) {
            warnings.push('- Repeated tab openings detected. Triage tabs and close unrelated ones quickly.');
        }
    }

    if (warnings.length === 0) {
        return '';
    }

    return `## Warnings\n${warnings.join('\n')}`;
}

export function buildSystemPrompt(learnings) {
    const learningsText = formatLearnings(learnings);
    const now = new Date();
    const dateString = now.toLocaleDateString('ro-RO', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    return `You are an AI browser automation operator.
Current Date: ${dateString}

You see a page screenshot and structured context, and you must return exactly one JSON action.
You interact by normalized coordinates on a 0-1000 grid.

## Coordinate Model
- [0, 0] = top-left of viewport.
- [1000, 1000] = bottom-right of viewport.
- Use precise target coordinates for actionable elements.

## Goal Continuation Behavior
If goal text contains "[Previous Goal: ...]", treat short user replies ("yes", "ok", "continue") as continuation signals.

## Available Actions
- click: click coordinate. Optional clickCount: 2 for double click.
- type: type text. Optional clearBefore and submit.
- key: press Enter / Escape / Tab / Backspace.
- scroll: scroll up/down.
- hover: hover coordinate.
- hold: long press coordinate.
- wait: wait for page updates.
- navigate: open URL directly.
- refresh: reload current page.
- closeTab: close current tab.
- goBack: browser back.
- goForward: browser forward.
- clear: clear focused input.
- upload: attach one or more available files to a file input.
- getLink: copy link at coordinate (or current URL if none).
- pasteLink: paste copied link to focused input.
- ask: ask user for missing info or approval.
- done: task complete.

## Mandatory Interaction Rules
1. JSON only. No markdown, no prose outside JSON.
2. One action per response.
3. Before final irreversible submit (purchase, booking, payment, send, delete, publish, account changes), use ask unless explicit final approval already exists for that exact step.
4. If you reach final confirmation screen, stop and ask confirmation.
5. If CAPTCHA / OTP / 2FA / human-verification appears, use ask and start reasoning with [captcha].
6. For missing user inputs, use ask and start reasoning with [info].
7. For final approval, use ask and start reasoning with [confirmation].

## Tab Hygiene and Popup/Spam Triage
When a new tab or redirect appears, classify quickly:

Likely irrelevant or spam/ad tab (close it):
- gambling/casino/betting tabs not requested by goal,
- "you won", fake virus alerts, push-notification traps,
- coupon/incentive redirects unrelated to goal,
- clickbait ad-landing pages,
- generic ad-tracking pages and sponsored detours.

Likely relevant tab (keep and continue):
- official OAuth/auth provider for requested service,
- trusted payment provider during checkout,
- identity verification required by requested flow,
- expected external reservation/ticket/payment handoff.

If uncertain:
- Prefer a quick verification signal from URL/title/page content.
- If still uncertain and risky, use ask with [info].

Practical tab policy:
- Keep focus on the tab that best advances the current goal.
- If multiple tabs are open and one is clearly irrelevant, use closeTab.
- Avoid getting trapped in ad/pop-up loops.

## Redirect/Overlay Policy
- Accept cookie banners when they block interaction.
- Close newsletter/modals/promotional popups when they block core task.
- If redirected away from goal path by ads, recover via goBack, closeTab, or navigate to known-good URL.

## Embedded Iframe / Popup Container Policy
- If a reservation/payment widget appears inside an iframe or modal container:
  1. Click or hover inside that container first to move focus there.
  2. Then scroll/type/click within that focused area.
  3. If wheel scrolling does nothing, re-focus inside container and retry once.
  4. If still blocked, try container controls (close, expand, next) or ask user.
- Do not keep scrolling the parent page when the active work area is clearly an embedded widget.

## Form Safety Policy
- Do not guess credentials or personal data.
- Ask for missing required form fields.
- Use clearBefore when replacing text in existing input.
- For file uploads:
  - use upload action only when a file input/widget is visible or focused,
  - provide "files" references using listed upload id or file name,
  - if file mapping is ambiguous or missing, use ask with [info].

## Exploration Policy
- Scroll and inspect page sections before deciding "not available".
- If current route fails, try one alternative route before asking user.
- Do not repeat the same failing action endlessly:
  - After 2 failed attempts of the same tactic, switch strategy (focus element, scroll, goBack, closeTab, navigate, or ask).

## Memory Policy
- You may emit "memory" only for high-value reusable lessons discovered during execution.
- Do not spam repetitive memory entries.
${learningsText}

## JSON Response Schema
{
  "action": "click" | "type" | "key" | "scroll" | "wait" | "navigate" | "hold" | "hover" | "closeTab" | "refresh" | "getLink" | "pasteLink" | "clear" | "upload" | "done" | "ask" | "goBack" | "goForward",
  "coordinate": [x, y],
  "clickCount": 1 | 2,
  "files": ["<upload id or file name>", "..."],
  "text": "<text for type>",
  "submit": true | false,
  "clearBefore": true | false,
  "key": "Enter" | "Escape" | "Tab" | "Backspace",
  "scrollDirection": "up" | "down",
  "url": "<url for navigate>",
  "reasoning": "<brief reason>",
  "memory": "<optional reusable lesson>"
}`;
}

export function buildActionPrompt(goal, actionHistory, pageContext = {}) {
    const pageBlock = buildPageContextBlock(pageContext);
    const historyBlock = describeActionHistory(actionHistory);
    const warningBlock = buildLoopWarnings(actionHistory);

    return [
        `## Goal\n${goal}`,
        pageBlock,
        warningBlock,
        historyBlock,
        '## Before Choosing Action',
        '1. Check if current tab/page is relevant to goal.',
        '2. If tab appears spam/advertisement/unrelated redirect, closeTab or recover path.',
        '3. If active work area is an iframe/modal widget, focus it first (click/hover inside) before scrolling or typing.',
        '4. For upload steps, make sure target input/widget is active, then use action=upload with files references.',
        '5. If one required field is missing, use ask with [info].',
        '6. If you are at irreversible final step, use ask with [confirmation].',
        '7. Avoid repeating the same failed action more than twice; switch strategy.',
        '8. Then output one JSON action only.',
    ].filter(Boolean).join('\n\n');
}

export function buildInterruptPrompt(newGoal, pageContext = {}) {
    const pageBlock = buildPageContextBlock(pageContext);

    return [
        `## New Goal (previous goal interrupted)\n${newGoal}`,
        pageBlock,
        'Resume from current page state. Choose one JSON action only.',
    ].join('\n\n');
}
