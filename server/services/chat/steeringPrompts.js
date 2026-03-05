export function buildDeferredSteeringPrompt(notes) {
    const normalizedNotes = (Array.isArray(notes) ? notes : [])
        .map((note) => String(note ?? '').trim())
        .filter(Boolean);
    if (normalizedNotes.length === 0) {
        return '';
    }

    if (normalizedNotes.length === 1) {
        return [
            'A user sent the following steering note during your previous response and it has not been addressed yet.',
            'Continue from the current conversation state and address it directly.',
            '',
            normalizedNotes[0],
        ].join('\n');
    }

    return [
        'A user sent the following steering notes during your previous response and they have not been addressed yet.',
        'Continue from the current conversation state and address all of them directly without omitting anything.',
        '',
        normalizedNotes.map((note, index) => `${index + 1}. ${note}`).join('\n'),
    ].join('\n');
}

export function buildBrowserResumeFollowUpNote(result) {
    const status = String(result?.status ?? '').trim().toLowerCase();
    const questionType = String(result?.questionType ?? '').trim().toLowerCase();
    const summary = String(result?.text ?? '').trim();

    if (status === 'awaiting_user' && questionType && questionType !== 'captcha') {
        return [
            `The Browser Agent resumed after a direct CAPTCHA handoff and is now waiting for ${questionType}.`,
            'Continue from the current conversation state and handle this yourself in chat.',
            'Do not tell the user to open the Browser Agent panel again unless a new CAPTCHA or another human-only verification appears.',
            '',
            summary,
        ].join('\n');
    }

    if (status === 'completed') {
        return [
            'The Browser Agent resumed after a direct CAPTCHA handoff and has now completed its task.',
            'Continue from the current conversation state and use the browser result directly.',
            'Do not ask the user to reopen the Browser Agent panel unless another CAPTCHA or human-only verification appears.',
            '',
            summary,
        ].join('\n');
    }

    if (status === 'error' || status === 'stopped') {
        return [
            `The Browser Agent resumed after a direct CAPTCHA handoff and ended with status: ${status}.`,
            'Continue from the current conversation state, explain the outcome, and decide the next best step.',
            'Do not ask the user to reopen the Browser Agent panel unless another CAPTCHA or human-only verification appears.',
            '',
            summary,
        ].join('\n');
    }

    return '';
}
