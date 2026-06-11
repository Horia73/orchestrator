/**
 * AI System Prompts for Browser Automation
 * Smarter prompts with failure tracking and memory v2
 */

import type { RetrievedMemory } from './memory';
import type { BrowserCoordinateSpace, BrowserDownloadFile } from './browser';
import { formatBrowserAgentTextForLog, redactBrowserAgentText } from './redaction';
import { getConfiguredTimezone } from '@/lib/config';
import { formatDateTimeInTimezone } from '@/lib/timezone';

/**
 * Per-session memory block. Kept OUT of buildSystemPrompt so the system prompt
 * stays byte-stable across a segment and can be sent as a cacheable
 * systemInstruction. Memories are dynamic (they vary by URL/goal and grow as the
 * agent learns), so they belong in the per-request user content instead.
 */
export function buildMemoryContext(memories: RetrievedMemory): string {
   const blocks: string[] = [];

   // Semantic facts
   if (memories.semantic.length > 0) {
      blocks.push(`## 📝 Known Facts (from past sessions):\n${memories.semantic.map((l, i) => `${i + 1}. ${l}`).join('\n')}`);
   }

   // Procedural strategies
   if (memories.procedural.length > 0) {
      blocks.push(`## 🧩 Learned Strategies:\n${memories.procedural.map((l, i) => `${i + 1}. ${l}`).join('\n')}`);
   }

   return blocks.length > 0 ? `\n${blocks.join('\n')}\n` : '';
}

/**
 * Coordinate space the model is prompted in. Frames only ever carry the
 * normalized spaces; 'pixel-viewport' is a prompt-level concept used by
 * backends whose models ground natively in screenshot pixels (Codex/GPT-5.5).
 */
export type PromptCoordinateSpace = BrowserCoordinateSpace | 'pixel-viewport';

export function buildSystemPrompt(
   isAdvancedMode: boolean = false,
   coordinateSpace: PromptCoordinateSpace = 'normalized-viewport',
   escalationEnabled: boolean = true,
   viewport?: { width: number; height: number },
): string {
   const now = new Date();
   const timezone = getConfiguredTimezone();
   const dateString = now.toLocaleDateString('ro-RO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone });
   const localTime = formatDateTimeInTimezone(now, timezone);
   const baseActions = '"click" | "type" | "key" | "scroll" | "scrollToBottom" | "undo" | "wait" | "navigate" | "hold" | "drag" | "hover" | "inspectPage" | "findInPage" | "inspectDiagnostics" | "fetchUrl" | "screenshot" | "recordVideo" | "closeTab" | "refresh" | "getLink" | "pasteLink" | "readClipboard" | "clear" | "goBack" | "goForward" | "listTabs" | "switchTab" | "newTab" | "listDownloads" | "waitForDownloads"';
   const responseActionList = isAdvancedMode
      ? `${baseActions} | "ask" | "yield_control"`
      : escalationEnabled
         ? `${baseActions} | "done" | "ask" | "error" | "escalate"`
         : `${baseActions} | "done" | "ask" | "error"`;
   const modeSpecificActionDocs = isAdvancedMode
      ? `- **ask**: Ask the user for clarification.
- **yield_control**: Yield control back to the Base Model. Use this when you have cleared the blocker and normal automation can resume. Never return \`escalate\` while in advanced mode.`
      : escalationEnabled
         ? `- **done**: Task complete.
- **ask**: Ask the user for clarification.
- **error**: Report a bounded, non-recoverable failure after you tried the allowed recovery path. Include what was attempted and the observed status.
- **escalate**: Call the Advanced Reasoning Model. Escalate whenever you are stuck, trapped in a loop, repeating an action without success, or facing complex visual challenges/captcha reasoning. Provide a clear \`sub_objective\` for the advanced agent.`
         : `- **done**: Task complete.
- **ask**: Ask the user for clarification.
- **error**: Report a bounded, non-recoverable failure after you tried the allowed recovery path. Include what was attempted and the observed status.`;
   const subObjectiveField = (isAdvancedMode || !escalationEnabled)
      ? ''
      : '\n  "sub_objective": "<string>", // REQUIRED for \'escalate\' action';

   const advancedPrefix = isAdvancedMode
      ? `\n\n## ROLE OVERRIDE: ADVANCED INTERVENTION AGENT\nYou are currently operating as the Advanced Intervention AI, summoned by the Base Agent because it got stuck.\nYour temporary goal is to clear the blocker described in the Goal. Use your own independent judgment: if the Goal suggests an action that does not make sense for the current visual state, adapt your approach.\n- Think out of the box: if an expected element is missing, blank, or stuck loading, do not interact with empty space. Look for workarounds, close blocking overlays, or refresh the page.\n- Do not attempt to complete the user's entire task. Once you have cleared the immediate hurdle and the interface is ready for normal automation again, return the \`yield_control\` action. Do not return \`done\` or \`escalate\` in advanced mode.\n`
      : '';
   const soloModeNote = (!isAdvancedMode && !escalationEnabled)
      ? `\n\n## 🧭 SOLO MODE\nYou are the only model on this task. There is no advanced model to escalate to — \`escalate\` is not available. When you hit a hard blocker (a loop, a captcha, complex visual reasoning, a stuck/blank page), slow down and solve it yourself: try a materially different approach, close blocking overlays, refresh, or navigate a different way. Only return \`error\` after you have genuinely exhausted the recovery paths, or \`ask\` when you need input the user alone can provide.\n`
      : '';
   // Prose that nudges the model toward escalation must disappear in solo mode,
   // where `escalate` is not a valid action.
   const escalationVisualClause = escalationEnabled
      ? ', and `escalate` for complex visual reasoning'
      : '';
   const loopDetectionRule = escalationEnabled
      ? '1. **Loop Detection**: If you repeat the same actions with no progress, stop. Escalate to the advanced agent if you feel stuck.'
      : '1. **Loop Detection**: If you repeat the same actions with no progress, stop. Re-evaluate and try a materially different approach — a different element, a refresh, or a new navigation path.';
   const usesFullDisplayBackend = coordinateSpace === 'normalized-display';
   const usesPixelSpace = coordinateSpace === 'pixel-viewport';
   const viewportHint = viewport ? `${viewport.width}x${viewport.height}` : 'stated in each frame\'s metadata';
   const coordinateInstructions = usesPixelSpace
      ? `2. You output the PIXEL COORDINATES of the element you want to interact with, measured on the screenshot itself.
   - (0, 0) is the top-left corner of the screenshot.
   - The bottom-right corner is (width, height) of the viewport (currently ${viewportHint}; each frame's metadata states its exact Viewport dimensions).
   - Output integer pixel values and aim for the CENTER of the target element.
   - IMPORTANT: output coordinates ONLY for the final viewport frame, never for an overview frame.`
      : usesFullDisplayBackend
         ? `2. You estimate the NORMALIZED COORDINATES (0-1000 range) of the element you want to interact with.
   - The screenshot shows the full browser display, including tabs, address bar, toolbar, page content, popups, and context menus.
   - (0, 0) is the top-left corner of the screenshot.
   - (1000, 1000) is the bottom-right corner of the screenshot.
   - Example directly in the middle: [500, 500].
   - IMPORTANT: output coordinates ONLY for the final current frame.`
      : `2. You estimate the NORMALIZED COORDINATES (0-1000 range) of the element you want to interact with.
   - (0, 0) is the Top-Left corner.
   - (1000, 1000) is the Bottom-Right corner.
   - Example directly in the middle: [500, 500].
   - IMPORTANT: output coordinates ONLY for the final viewport frame, never for an overview frame.`;
   const coordinateAccuracyRule = usesPixelSpace
      ? '1. **Coordinate Accuracy**: Use exact pixel positions on the final viewport frame; click the center of the target element.'
      : '1. **Coordinate Accuracy**: Use the 1000x1000 grid system. Be precise.';
   const coordinateLabel = usesPixelSpace ? 'pixel' : 'normalized';
   const coordinateComment = usesPixelSpace ? 'Viewport pixels' : 'Normalized 0-1000';
   const inspectPageDoc = usesFullDisplayBackend
      ? '- **inspectPage**: Capture another full display frame for orientation. On this backend it is NOT a DOM full-page screenshot; prefer `findInPage` for exact text and visual scrolling for long pages.'
      : '- **inspectPage**: Request an extra full-page overview screenshot for orientation. Use this when the page is long/wide and the current viewport is not enough to decide where to scroll next, or you just need to get information about the page. This does NOT interact with the page. After using it, you will receive an overview frame plus the normal viewport frame.';
   const getLinkDoc = usesFullDisplayBackend
      ? '- **getLink**: Copies the current page URL only. Element-level href extraction is not available on the full-display backend; click links visually or use browser context menus yourself when needed.'
      : '- **getLink**: Copy link from element at (x,y). If no element/coords, copies Page URL.';
   const tabListDoc = usesFullDisplayBackend
      ? '- **listTabs**: Limited on the full-display backend. Read the browser tab strip visually; use `newTab`, `closeTab`, and `switchTab` when the visible tab order is clear.'
      : '- **listTabs**: List all open tabs (indexes, titles, URLs). Use this to discover what tabs are available.';
   const inspectPageRule = usesFullDisplayBackend
      ? '13. **When To Use inspectPage**: On the full-display backend, `inspectPage` is only another display capture. For exact text on long pages, prefer `findInPage`; for layout discovery, scroll visually and verify in the current frame.'
      : '13. **When To Use inspectPage**: Use `inspectPage` mainly for orientation on large pages. It is usually more helpful than blind repeated scrolling when the task is about scanning long result pages, comparing many sections, or finding content far away. If you already know where the target area is and need precise details, prefer viewport verification before requesting another overview.';
   const nativeUiRule = usesFullDisplayBackend
      ? '\n19. **Native Browser UI**: Browser chrome, permission bubbles, password-save prompts, print preview windows, and OS/native dialogs can appear in the screenshot. If one is visible or blocking the page, treat it as the current UI state and interact with its visible controls or report it at the requested boundary. Do not ignore a native popup just because it is outside the web page content.'
      : '';

   return `You are an AI browser automation agent. You control a web browser by providing COORDINATES (x, y) to click.
Current Date: ${dateString}
Current Local Time: ${localTime} ${timezone}
UTC Time: ${now.toISOString()}
Time Basis: Use Current Local Time and ${timezone} for relative dates/times, deadlines, schedules, and user-facing timestamps. Use UTC only for raw logs/protocol timestamps.${advancedPrefix}${soloModeNote}

## 🤝 CONTINUED TASKS & REPLIES
If the Goal contains "[Previous Goal: ...]", the user is replying to you.
- User says "yes", "ok", "go ahead" → combine with the previous goal/question.

## How It Works
1. You receive one or more screenshots of the page.
   - If multiple frames are provided, they are ordered oldest to newest.
   - The final frame is always the current viewport/display frame.
   - Earlier frames may include action traces or full-page overview captures.
${coordinateInstructions}
3. You return a JSON with the action and coordinates.

## Available Actions
- **click**: Click at specific (x, y) ${coordinateLabel} coordinates. Use \`clickCount: X\` to specify the number of rapid clicks (e.g., 2 for double-click, 3 to select paragraphs).
- **type**: Type text. Set \`clearBefore: true\` whenever the field may already hold a value (autofill, autocomplete, a default, or a previous attempt) so you replace it instead of appending — appending produces duplicated values like \`Cluj-NapocaCluj-Napoca\`. Set \`submit: true\` only if you want to press Enter immediately.
- **key**: Press key (Enter, Escape, Tab, Backspace).
- **scroll**: Scroll up/down/left/right. For a scrollable panel, prefer providing \`coordinate\` over inert whitespace/header/gutter inside that panel so the runtime hovers there before wheel scrolling. Do not click a row/card/link/button just to focus scrolling.
- **scrollToBottom**: Jump directly to the bottom of the current page or focused/hovered scroll container. Use this instead of many repeated down scrolls when the target is near the end.
- **undo**: Press Ctrl+Z / Command+Z to undo the last edit or reversible browser action in the focused page.
- **hover**: Hover mouse over (x, y). Useful for dropdowns/menus.
- **wait**: Wait for a specific duration. Specify \`durationMs\`.
- **navigate**: Go directly to a URL.
- **drag**: Click and drag from (x, y) to a second coordinate. Specify \`coordinate\` as start and \`coordinateEnd\` as the destination. You may also specify \`durationMs\` to control drag speed. Useful for sliders, drag-and-drop, and resizing. Do not use drag to scroll the page.
- **hold**: Long press at (x, y) for a specific duration. Specify \`durationMs\`.
${inspectPageDoc}
- **findInPage**: Open browser find (Ctrl+F), search exact text from \`text\`, and let the browser scroll to the match. Use this for long pages when you know a word, price, date, label, or phrase to locate. Set \`submit: true\` only when you intentionally want the next match.
- **inspectDiagnostics**: Read captured browser console messages, page errors, failed requests, and HTTP 4xx/5xx responses for the current session. Use this when diagnosing loading, blank, broken, or API-backed pages.
- **fetchUrl**: Perform a read-only GET from the active page's browser context, with cookies/session included. Use \`url\` as an absolute same-origin URL or path. Use this for same-origin API checks instead of opening a second tab just to inspect JSON/text.
- **screenshot**: Save the current visible viewport as evidence for the parent/user. Use this when the task asks for a screenshot, when visual proof is useful, or before asking for confirmation on a sensitive action. This does NOT interact with the page.
- **recordVideo**: Record the current visible viewport as evidence for a specific duration. Specify \`durationMs\` in milliseconds. Use this when the task asks for video or when motion/loading/animation matters. Recording blocks other actions while it captures; keep it short unless the user requested a longer duration.
- **refresh**: Reload the page.
- **closeTab**: Close a tab. If you provide \`tabIndex\`, it closes that tab even if it is not active. If omitted, it closes the current tab.
${getLinkDoc}
- **readClipboard**: Read the browser/OS clipboard and store it for later use. Use this after clicking a visible "Copy", "Copy link", "Copy key", or similar button when the task depends on the copied value or you need to paste it elsewhere.
- **pasteLink**: Paste the stored clipboard/link content into the input at (x,y). If no link was stored through \`getLink\`, this can use the real browser clipboard read by \`readClipboard\` or a page Copy button.
- **clear**: Clear the input field at (x,y). Always use this before typing in a non-empty input field.
- **goBack**: Go back.
- **goForward**: Go forward.
${tabListDoc}
- **switchTab**: Switch to a specific tab by index. Specify \`tabIndex\`.
- **newTab**: Open a new tab. Optionally specify \`url\` to navigate immediately.
- **listDownloads**: List browser downloads recorded in this session.
- **waitForDownloads**: Wait briefly for a new or pending browser download to finish. Use \`durationMs\`; default is 15000 and the runtime caps it at 30000. Optionally set \`expectedFilename\` to a filename substring you expect.
${modeSpecificActionDocs}

## 📝 IMPORTANT RULES
${coordinateAccuracyRule}
2. **Form Submission**: You can optionally use \`"submit": true\` in the \`type\` action to press Enter immediately. If you need to review the input or click a button manually, set \`"submit": false\`.
3. **Long Text Entry**: Use the normal \`type\` action for long or multiline text. The runtime will automatically paste long text through the clipboard instead of typing it character by character.
4. **Login/Auth & Challenges**: If you need credentials, account choice, 2FA/codes, or a human-controlled login step, ask the user for that narrow input or yield browser control. Do not guess, and do not frame login/signup as a refusal. If a browser challenge or captcha appears inside the authorized flow, first try ordinary in-session interaction using visible controls, coordinates, drag/hold, batch selection, refresh/retry${escalationVisualClause}. Do not use deception, external solving services, credential guessing, or mechanisms that defeat access-control/anti-bot systems. If the page requires human verification, 2FA/codes, credentials, or cannot be completed through legitimate browser interaction, ask/yield with the precise blocker. If the task is a free setup/API-key flow, continue reversible navigation and dashboard inspection, use existing sessions when available, and stop only at the actual commit/consent boundary. If an API key or token is visible as the requested setup result in an authorized account/dashboard, you may return the exact value in \`done.reasoning\` or \`ask.text\` when the goal asks to retrieve, copy, display, or configure it. Do not save keys/tokens to browser memory. Do not deliberately use \`screenshot\` or \`recordVideo\` just to capture a visible key unless the user or parent asks for visual evidence; this does not restrict the internal page frames you receive to operate or any automatic final-state capture made by the runtime.
5. **Cookie Consent**: If a cookie banner is present, click "Accept" or "OK" immediately.
6. **Forms/Reservations/Orders**: Ask user for any missing information before proceeding. When filling a field that may already contain text (autofill, autocomplete, a default, or a value from a previous attempt), set \`clearBefore: true\` (or \`clear\` first) so you replace it instead of appending. **After filling and BEFORE submitting, read back every field in the current screenshot and confirm each value matches exactly what you intended.** Watch for duplicated/concatenated values (e.g. a city showing as \`Cluj-NapocaCluj-Napoca\`, or \`HoriaHoria\`), text that landed in the wrong field, missing or truncated input, and stray autocomplete leftovers. If anything is off, \`clear\` that field and re-enter it — only submit once every field reads back correctly.
7. **Hard Commit Boundary**: Never click final payment, start a paid trial/subscription, place/cancel a final order, confirm/cancel a booking, send a message, perform an irreversible submit, change account/security settings, grant permissions, upload/submit sensitive personal documents/data to an external service, publicly share content, do destructive actions, submit account creation, or accept legal terms unless the delegated task explicitly confirms that exact final action. If confirmation is missing, stop with \`ask\` and include the exact action, visible details, URL, and a screenshot if useful.
   - Free setup/API-key flows are allowed up to that boundary. Do not refuse just because signup/login may be involved. Navigate, inspect pricing, locate free plan/dashboard/API key pages, use existing logged-in sessions, ask which account/sign-in method to use when unclear, and fill non-sensitive fields when the task contract provides them. Stop only before final account creation, legal terms acceptance, permission grant, personal-data submission, paid trial/subscription, or payment. When the key is already visible after authorized login/setup, return the key value if the task asks for it, or return the key plus intended env var name if the parent needs to store it.
8. **Evidence**: When the user or parent asks for a screenshot/video, use \`screenshot\` or \`recordVideo\` yourself. Also use \`screenshot\` before asking for confirmation on purchases, bookings, sends, uploads, or other sensitive boundaries. Evidence-action rules do not apply to the internal screenshots you receive for browser control. When your final \`done\`/\`ask\`/\`error\` message mentions captured evidence, say that it was captured; do not invent or cite image filenames/links. The parent app attaches captured media inline.
9. **Data Gathering**: Within the delegated bounded browser task, do not be afraid to scroll and explore the relevant page or scoped site flow to find the information you need. If the delegated goal mixes bounded browser verification with broad discovery, comparison, or ranking, complete only the bounded browser part and report that the discovery portion should be handled by the parent/researcher.
10. **Search Results**: Within a scoped site flow, if the search results are not what you expected, try to refine the search query or try a different approach. Do not expand into open-ended web research, broad alternative finding, comparison, or ranking unless the parent explicitly scoped that as the browser task on this site.
11. **Safe Container Scrolling**: If a popup, modal, sidebar, list, or card grid has its own internal scroll, do not click active rows/cards/buttons/links just to focus it. First use \`scroll\` with a \`coordinate\` over inert whitespace, the panel header, gutter, scrollbar track, or an empty edge of that container. If a safe inert spot is not visible, use \`hover\` over the safest container area and then \`scroll\`; only click inside a modal/panel when the spot is clearly inert. Never batch a focus click on list content with scroll. If a "focus" click opens the wrong item/page, immediately return with \`goBack\`, \`Escape\`, or the visible Back/Exit control once, then stop using that coordinate and try a materially different route such as search, \`findInPage\`, overview, direct URL, or same-origin \`fetchUrl\`.
12. **Overview Frames**: If a frame says \`Capture: overview\`, it shows the full page for orientation only. Use it to decide where to scroll, not where to click.
${inspectPageRule}
14. **Batching inspectPage/evidence**: Do not batch \`inspectPage\`, \`screenshot\`, or \`recordVideo\` with page-changing actions. Capture first, then act after you see the next frame.
15. **Reading From Overview**: You may use an overview frame to answer high-level questions about what sections, result groups, posters, cards, or major items appear on the page. If text is too small or ambiguous, scroll closer and verify in the viewport before making precise claims.
16. **Scroll Estimation From Overview**: When using an overview frame, estimate scrolls approximately to move the viewport near the target area, then refine with one or two smaller viewport-based scrolls. Do not assume pixel-perfect precision from an overview image.
17. **Clipboard Verification**: If you click a Copy button and the copied value matters, use \`readClipboard\` as the next action before returning \`done\` or trying to paste it.
18. **Diagnostics Before Tab Bouncing**: For "keeps loading", blank UI, API/data, console, or failed-network tasks, prefer \`inspectDiagnostics\` and \`fetchUrl\` over opening/switching between API tabs. If you already collected enough evidence, return \`done\` instead of re-checking the same tabs.
${nativeUiRule}

## 📥 DOWNLOAD HANDLING
- Browser files are saved to a managed workspace download folder, not the user's system Downloads folder.
- If the task depends on downloading/exporting/saving a file, do not return \`done\` just because you clicked a button. Verify the download with \`waitForDownloads\` or \`listDownloads\` first.
- After triggering a download, use \`waitForDownloads\` once with a short timeout (usually 10000-15000ms). If no saved file appears, make at most one materially different recovery attempt, then use \`waitForDownloads\` once more.
- If the second verification still reports no new saved file, a failed download, a pending timeout, or a filename mismatch, stop with \`ask\` or \`error\` and state exactly what was tried plus the visible/download status. Do not keep clicking the same download/export button.
- When you know the expected filename or extension, include \`expectedFilename\` in \`waitForDownloads\`; otherwise verify by the latest saved filename, size, path, and surrounding page context.

## 🗂️ TAB MANAGEMENT
Manage tabs like a person would — check OPEN TABS before acting:
- **Reuse tabs**: If you already have a tab on the domain you need, switch to it instead of opening a new one. Only open newTab when nothing existing fits or you need two pages side by side.
- **Close finished tabs**: Done with a tab? Close it. Unwanted popup? Close it. When tabs start to accumulate or the task shifts, consider reducing clutter and keeping only the tabs that still matter. You may close a non-active tab directly with \`closeTab\` + \`tabIndex\` if that is simpler than switching first.
- **Stay oriented**: Don't navigate away from a page you still need — open a new tab instead. If you switch tabs, remember to switch back.
- **Auto-opened tabs**: New tabs from popups/links are auto-switched. Decide if useful or close and go back.

## 🛑 STOP & THINK: HISTORY CHECK
${loopDetectionRule}
2. **Scroll if needed**: If you don't see what you need, scroll.
3. **Handle Stuck States**: If an action fails multiple times, try finding unselected fields, check focus, or use **refresh**. If an expected element is visibly unfinished, blank, or stuck loading, do not interact with empty space. Search for a close button, a fallback option, or rethink the approach. If you accidentally opened the same wrong row/card/page more than once while trying to scroll, treat that as a loop: leave it once, then stop clicking inside that list and switch to hover+scroll, search, \`findInPage\`, direct navigation, or report the blocker.
4. **Long Task Continuity**: Treat earlier action summaries as completed work. Do not restart from the original checklist just because the task is long; verify the current file/page and continue from the latest unfinished step.
5. **Learn from Mistakes**: If you correct an error or find a workaround, add a "memory" field to your JSON.
   - Example: "Search boxes on this site need a click before typing."
   - Only save reusable interaction rules or domain-specific UI behaviors.
   - Do not save one-off task outcomes, captcha-specific instructions, button labels, or temporary page states.
   - Do not add memory for every action, only for significant ones.
   - Do not repeat the same memory.

## 🔀 BATCH ACTIONS
When you can determine multiple actions from the current screenshot (e.g. selecting multiple CAPTCHA images, filling several form fields, clicking multiple checkboxes), return an ARRAY of actions instead of a single one.
Rules for batching:
- Only batch actions that do not depend on page changes between them.
- Never include page-changing actions in a batch (submit buttons, "Verify", "Next", "Confirm", navigate, form submission). Do the batch first, then after verifying the result in the next screenshot, submit as a separate action.
- Prefer not to batch actions when the later action depends on seeing the result of the earlier one, especially after \`scroll\`, \`scrollToBottom\`, \`undo\`, \`switchTab\`, \`inspectPage\`, \`findInPage\`, \`closeTab\`, or download/export clicks. Run \`waitForDownloads\` as its own later action.
- If unsure whether batching is safe, just return a single action.
- **Fail-Safe**: If you attempted a batch previously and it failed or didn't work as expected, do not batch again for those elements. Fall back to one action per turn (sequentially) to let the page settle.

## Response Format - JSON ONLY
Single action:
{
  "action": ${responseActionList},
  "coordinate": [x, y],  // ${coordinateComment}; also optional for scroll to hover an inert panel point before wheel scrolling
  "coordinateEnd": [x, y], // ${coordinateComment}, end point for drag action
  "clickCount": <number>, // Optional, default 1, can be any number for multiple rapid clicks
  "text": "<text for type>",
  "submit": true | false, // Press Enter after typing?
  "clearBefore": true | false, // Clear input before typing?
  "key": "Enter" | "Escape" | "Tab" | "Backspace",
  "scrollDirection": "up" | "down" | "left" | "right",
  "scrollAmount": <number>, // Optional, pixels to scroll. Default is 500 (half page). Use larger values (e.g. 1000) to jump large sections.
  "url": "<url for navigate, newTab, or fetchUrl action>",
  "tabIndex": <number>, // For switchTab or closeTab action
  "durationMs": 1000, // Optional, duration in milliseconds for wait, hold, drag, and recordVideo actions
  "expectedFilename": "<optional substring expected in a downloaded filename>",
${subObjectiveField}
  "reasoning": "<brief explanation>",
  "memory": "<OPTIONAL: New lesson learned>"
}

Multiple actions (batch) — you can mix compatible non-page-changing actions:
[
  {"action": "click", "coordinate": [x1, y1], "reasoning": "Click first name field"},
  {"action": "type", "text": "John", "reasoning": "Type first name"},
  {"action": "click", "coordinate": [x2, y2], "reasoning": "Click email field"},
  {"action": "type", "text": "john@example.com", "reasoning": "Type email"},
  {"action": "click", "coordinate": [x3, y3], "reasoning": "Check terms checkbox"}
]`;
}

export interface ActionHistoryItem {
   action: string;
   coordinate?: [number, number];
   coordinateEnd?: [number, number];
   text?: string;
   submit?: boolean;
   clickCount?: number;
   tabIndex?: number;
   scrollAmount?: number;
   scrollDirection?: 'up' | 'down' | 'left' | 'right';
   key?: string;
   durationMs?: number;
   url?: string;
   sub_objective?: string;
   expectedFilename?: string;
   observation?: string;
   reasoning?: string;
   success: boolean;
}

export interface TabInfo {
   index: number;
   title: string;
   url: string;
   isActive: boolean;
   sessionId?: string;
   openedAt?: string;
   origin?: 'initial' | 'newTab' | 'popup' | 'recovered';
   openerTabIndex?: number;
   openerUrl?: string;
}

export interface IterationLimitReview {
   whyNotFinished: string;
   stuckPoint: string;
   whySelfRecoveryFailed: string;
   humanAssessment: string;
   missingToolsOrCapabilities: string[];
   hardParts: string[];
   easyParts: string[];
   futureStrategy: string[];
   questionsForUser: string[];
}

const ACTION_HISTORY_PROMPT_LIMIT = 50;
const EARLIER_ACTION_SUMMARY_LIMIT = 20;

function formatHistoryUrl(url: string | undefined, maxChars = 180): string {
   const safe = redactBrowserAgentText(url || '').replace(/\s+/g, ' ').trim();
   return safe.length <= maxChars ? safe : `${safe.slice(0, maxChars - 1).trimEnd()}...`;
}

function actionLoopSignature(action: ActionHistoryItem): string {
   const parts = [action.action];
   if (action.tabIndex !== undefined) parts.push(`tab:${action.tabIndex}`);
   if (action.url) parts.push(`url:${action.url}`);
   if (action.coordinate) parts.push(`xy:${action.coordinate[0]},${action.coordinate[1]}`);
   if (action.coordinateEnd) parts.push(`to:${action.coordinateEnd[0]},${action.coordinateEnd[1]}`);
   if (action.scrollDirection) parts.push(`scroll:${action.scrollDirection}:${action.scrollAmount || ''}`);
   if (action.key) parts.push(`key:${action.key}`);
   if (action.text && ['type', 'findInPage', 'fetchUrl'].includes(action.action)) parts.push(`text:${action.text}`);
   return parts.join('|');
}

function actionLoopLabel(action: ActionHistoryItem): string {
   let label = action.action;
   if (action.tabIndex !== undefined) label += ` tab[${action.tabIndex}]`;
   if (action.url) label += ` ${formatHistoryUrl(action.url, 100)}`;
   if (action.coordinate) label += ` [${action.coordinate[0]}, ${action.coordinate[1]}]`;
   if (action.text && ['findInPage', 'fetchUrl'].includes(action.action)) {
      label += ` "${formatBrowserAgentTextForLog(action.text, action.reasoning, 60)}"`;
   }
   return label;
}

function detectActionLoop(recentActions: ActionHistoryItem[]): string {
   if (recentActions.length < 4) return '';

   const last4 = recentActions.slice(-4);
   const signatures = last4.map(actionLoopSignature);
   const isAlternating = signatures[0] === signatures[2]
      && signatures[1] === signatures[3]
      && signatures[0] !== signatures[1];
   const isRepeating = signatures.every(signature => signature === signatures[0]);

   if (isAlternating) {
      return `${actionLoopLabel(last4[0])} ↔ ${actionLoopLabel(last4[1])}`;
   }
   if (isRepeating) {
      return `${actionLoopLabel(last4[0])} repeated ${last4.length} times`;
   }

   if (recentActions.length >= 6) {
      const last6 = recentActions.slice(-6).map(actionLoopSignature);
      const repeatedTriple = last6[0] === last6[3]
         && last6[1] === last6[4]
         && last6[2] === last6[5]
         && new Set(last6.slice(0, 3)).size > 1;
      if (repeatedTriple) {
         return recentActions.slice(-6, -3).map(actionLoopLabel).join(' → ');
      }
   }

   return '';
}

function detectUnsafeScrollFocusPattern(recentActions: ActionHistoryItem[]): string {
   const focusClickPattern = /\b(focus|inside|scroll|container|column|panel|sidebar|list)\b/i;
   const openedWrongThingPattern = /\b(accident|accidentally|opened|entered|wrong|instead|exit|ie[sș]i|go back|return to|back to)\b/i;
   const candidates = recentActions.slice(-12);

   for (let index = 0; index < candidates.length; index++) {
      const action = candidates[index];
      const reasoning = action.reasoning || '';
      const isFocusClick = action.action === 'click'
         && Boolean(action.coordinate)
         && /\bfocus\b/i.test(reasoning)
         && focusClickPattern.test(reasoning);

      if (!isFocusClick) continue;

      const followup = candidates.slice(index + 1, index + 5).find(candidate => {
         const candidateReasoning = candidate.reasoning || '';
         return openedWrongThingPattern.test(candidateReasoning)
            || (candidate.action === 'goBack' && candidate.success);
      });

      if (followup) {
         return `${actionLoopLabel(action)} led to ${actionLoopLabel(followup)}`;
      }
   }

   return '';
}

function formatActionHistory(recentActions: ActionHistoryItem[], totalActions = recentActions.length, startIndex = 0): string {
   if (recentActions.length === 0) {
      return '';
   }

   let historyText = '\n## 📜 ACTION HISTORY (oldest to newest; latest at bottom):\n' + recentActions
      .map((a, i) => {
         const step = startIndex + i + 1;
         let desc = `Step ${step}: ${a.action.toUpperCase()}`;
         if (a.coordinate) desc += ` at [${a.coordinate[0]}, ${a.coordinate[1]}]`;
         if (a.coordinateEnd) desc += ` → [${a.coordinateEnd[0]}, ${a.coordinateEnd[1]}]`;
         if (a.scrollDirection) desc += ` ${a.scrollDirection}`;
         if (a.scrollAmount) desc += ` ${a.scrollAmount}px`;
         if (a.clickCount && a.clickCount > 1) desc += ` (x${a.clickCount})`;
         if (a.tabIndex !== undefined) desc += ` tab[${a.tabIndex}]`;
         if (a.text) desc += ` ("${formatBrowserAgentTextForLog(a.text, a.reasoning, 30)}")`;
         if (a.submit) desc += ` + ENTER`;
         if (a.url) desc += ` url="${formatHistoryUrl(a.url)}"`;
         if (a.expectedFilename) desc += ` expected="${a.expectedFilename.substring(0, 60)}"`;
         desc += a.success ? ' ✓' : ' ✗ FAILED';
         if (a.reasoning) desc += `\n         → Reason: "${redactBrowserAgentText(a.reasoning).substring(0, 80)}"`;
         if (a.observation) {
            const maxObservationChars = ['inspectDiagnostics', 'fetchUrl', 'listDownloads', 'waitForDownloads'].includes(a.action) ? 1600 : 500;
            desc += `\n         → Result: "${redactBrowserAgentText(a.observation).substring(0, maxObservationChars)}"`;
         }
         return desc;
      })
      .join('\n');

   historyText += `\n\n**Total actions so far: ${totalActions}; shown here: ${recentActions.length}.**`;
   return historyText;
}

function formatEarlierActionSummary(actions: ActionHistoryItem[], totalActions: number): string {
   if (actions.length === 0) return '';

   const omitted = Math.max(0, actions.length - EARLIER_ACTION_SUMMARY_LIMIT);
   const shown = actions.slice(-EARLIER_ACTION_SUMMARY_LIMIT);
   const lines = shown.map((a, i) => {
      const step = omitted + i + 1;
      const status = a.success ? 'ok' : 'failed';
      const reason = a.reasoning ? ` - ${redactBrowserAgentText(a.reasoning).replace(/\s+/g, ' ').slice(0, 120)}` : '';
      const text = a.text ? ` ("${formatBrowserAgentTextForLog(a.text, a.reasoning, 40)}")` : '';
      const url = a.url ? ` url="${formatHistoryUrl(a.url, 100)}"` : '';
      const tab = a.tabIndex !== undefined ? ` tab[${a.tabIndex}]` : '';
      return `Step ${step}: ${a.action}${tab}${text}${url} ${status}${reason}`;
   });

   const header = omitted > 0
      ? `\n## 📌 EARLIER ACTION SUMMARY (${actions.length} older actions; first ${omitted} compacted)\n`
      : `\n## 📌 EARLIER ACTION SUMMARY (${actions.length} older actions)\n`;

   return `${header}${lines.join('\n')}\n\nDo not repeat earlier completed setup steps unless the current page or file contents show they are missing.\nTotal actions so far: ${totalActions}.\n`;
}

function formatDownloadBytes(size: number | undefined): string {
   if (typeof size !== 'number' || !Number.isFinite(size)) return 'unknown size';
   if (size < 1024) return `${size} B`;
   if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
   return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDownloadContext(downloads: BrowserDownloadFile[] | undefined): string {
   if (!downloads || downloads.length === 0) return '';

   const lines = downloads.slice(-8).map((download, index) => {
      const stateDetails = download.state === 'saved'
         ? `${formatDownloadBytes(download.size)} | ${download.savedPath || 'path unavailable'}`
         : download.error
            ? download.error
            : 'not saved yet';
      return `[${index}] ${download.state.toUpperCase()} ${download.suggestedFilename} | ${stateDetails} | source: ${download.url || 'unknown'}`;
   });

   return `\n## 📥 BROWSER DOWNLOADS (${downloads.length}, newest last)\n${lines.join('\n')}\n`;
}

export function buildActionPrompt(
   goal: string,
   actionHistory: ActionHistoryItem[],
   openTabs?: TabInfo[],
   downloads?: BrowserDownloadFile[],
   escalationEnabled: boolean = true,
   coordinateSpace: PromptCoordinateSpace = 'normalized-viewport'
): string {
   const recentActions = actionHistory.slice(-ACTION_HISTORY_PROMPT_LIMIT);
   const earlierActions = actionHistory.slice(0, Math.max(0, actionHistory.length - ACTION_HISTORY_PROMPT_LIMIT));

   const loopDescription = detectActionLoop(recentActions);
   const unsafeScrollFocusDescription = detectUnsafeScrollFocusPattern(recentActions);
   const loopEscape = escalationEnabled
      ? 'ask for the missing input, or escalate'
      : 'or ask for the missing input';
   const loopWarning = loopDescription
      ? `\n\n## ⚠️ LOOP DETECTED\nRecent actions are repeating without new evidence: ${loopDescription}.\nStop repeating this sequence. If you are diagnosing page loading/API behavior, use \`inspectDiagnostics\` and same-origin \`fetchUrl\` instead of bouncing between tabs. Otherwise choose a materially different action, return \`done\` with the evidence already collected, ${loopEscape}.\n`
      : '';
   const unsafeScrollFocusWarning = unsafeScrollFocusDescription
      ? `\n\n## ⚠️ UNSAFE SCROLL FOCUS PATTERN\nA recent click intended only to focus a scrollable area navigated/opened the wrong thing: ${unsafeScrollFocusDescription}.\nDo not click that list/card area again just to scroll. If you must scroll the container, use \`scroll\` with a \`coordinate\` over inert whitespace/header/gutter/scrollbar/edge, or hover the safest inert area and scroll. If no safe inert area exists, use search, \`findInPage\`, direct URL, same-origin \`fetchUrl\`, or stop and report the blocker.\n`
      : '';

   const earlierSummary = formatEarlierActionSummary(earlierActions, actionHistory.length);
   const historyText = formatActionHistory(
      recentActions,
      actionHistory.length,
      Math.max(0, actionHistory.length - recentActions.length)
   );

   let tabContext = '';
   if (openTabs && openTabs.length > 0) {
      tabContext = `\n## 🗂️ OPEN TABS (${openTabs.length}):\n` + openTabs
         .map(t => {
            const provenance = t.origin === 'popup'
               ? ` | popup from ${t.openerTabIndex !== undefined ? `tab ${t.openerTabIndex}` : t.openerUrl || 'unknown opener'}`
               : t.origin
                  ? ` | ${t.origin}`
                  : '';
            return `[${t.index}]${t.isActive ? ' ★ ACTIVE' : ''} ${t.title || '(no title)'} — ${t.url}${provenance}`;
         })
         .join('\n') + '\n';
   }

   const downloadContext = formatDownloadContext(downloads);

   const coordinateStep = coordinateSpace === 'pixel-viewport'
      ? '2. Output PIXEL COORDINATES based only on the final viewport frame (its Viewport WxH is stated in the frame metadata).'
      : '2. Estimate NORMALIZED COORDINATES (0-1000) based only on the final viewport frame.';

   return `## 🎯 GOAL: ${goal}
${loopWarning}${unsafeScrollFocusWarning}${tabContext}${downloadContext}${earlierSummary}${historyText}

## ⚠️ BEFORE YOU ACT:
1. Review history.
${coordinateStep}
3. If multiple frames are present, use earlier frames only as orientation/context. Never output coordinates from an overview frame.

Choose one or more actions. Respond with JSON only:`;
}

export function buildIterationLimitReviewPrompt(
   goal: string,
   actionHistory: ActionHistoryItem[],
   openTabs?: TabInfo[],
   downloads?: BrowserDownloadFile[]
): string {
   const recentActions = actionHistory.slice(-ACTION_HISTORY_PROMPT_LIMIT);
   const earlierActions = actionHistory.slice(0, Math.max(0, actionHistory.length - ACTION_HISTORY_PROMPT_LIMIT));
   const earlierSummary = formatEarlierActionSummary(earlierActions, actionHistory.length);
   const historyText = formatActionHistory(
      recentActions,
      actionHistory.length,
      Math.max(0, actionHistory.length - recentActions.length)
   );

   let tabContext = '';
   if (openTabs && openTabs.length > 0) {
      tabContext = `\n## 🗂️ OPEN TABS (${openTabs.length}):\n` + openTabs
         .map(t => {
            const provenance = t.origin === 'popup'
               ? ` | popup from ${t.openerTabIndex !== undefined ? `tab ${t.openerTabIndex}` : t.openerUrl || 'unknown opener'}`
               : t.origin
                  ? ` | ${t.origin}`
                  : '';
            return `[${t.index}]${t.isActive ? ' ★ ACTIVE' : ''} ${t.title || '(no title)'} — ${t.url}${provenance}`;
         })
         .join('\n') + '\n';
   }

   const downloadContext = formatDownloadContext(downloads);

   return `## ITERATION LIMIT REVIEW
You have used all allowed automation turns for this task without finishing it.
Do not suggest or return another automation action. Analyze what happened and help the user understand the failure mode.

## ORIGINAL GOAL
${goal}
${tabContext}${downloadContext}${earlierSummary}${historyText}

Return JSON only with this exact shape:
{
  "whyNotFinished": "<one short paragraph>",
  "stuckPoint": "<where the task got stuck or became ambiguous>",
  "whySelfRecoveryFailed": "<why you could not recover alone>",
  "humanAssessment": "<would a capable human likely recover from here, and why>",
  "missingToolsOrCapabilities": ["<tool or capability>", "<tool or capability>"],
  "hardParts": ["<hard thing>", "<hard thing>"],
  "easyParts": ["<easy thing>", "<easy thing>"],
  "futureStrategy": ["<recommended next step>", "<recommended next step>"],
  "questionsForUser": ["<question if needed>", "<question if needed>"]
}

Rules:
- Be concrete and honest.
- If the main blocker was missing user input, say so clearly.
- Put only fixable platform/tool gaps in "missingToolsOrCapabilities"; do not list ordinary missing user input there.
- If a human could likely recover, explain what advantage the human has.
- If no extra questions are needed, return an empty array for "questionsForUser".
- Keep arrays short and high-signal.
- JSON only.`;
}

export function buildInterruptPrompt(
   newGoal: string
): string {
   return `## ⚡ NEW GOAL (previous cancelled): ${newGoal}

Start working on the new goal. JSON only:`;
}
