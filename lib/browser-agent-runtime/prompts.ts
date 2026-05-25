/**
 * AI System Prompts for Browser Automation
 * Smarter prompts with failure tracking and memory v2
 */

import type { RetrievedMemory } from './memory';
import type { BrowserCoordinateSpace, BrowserDownloadFile } from './browser';
import { formatBrowserAgentTextForLog, redactBrowserAgentText } from './redaction';

export function buildSystemPrompt(
   memories: RetrievedMemory,
   isAdvancedMode: boolean = false,
   coordinateSpace: BrowserCoordinateSpace = 'normalized-viewport',
): string {
   let memoryBlock = '';

   // Semantic facts
   if (memories.semantic.length > 0) {
      memoryBlock += `\n## 📝 Known Facts (from past sessions):\n${memories.semantic.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
   }

   // Procedural strategies
   if (memories.procedural.length > 0) {
      memoryBlock += `\n## 🧩 Learned Strategies:\n${memories.procedural.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
   }

   const learningsText = memoryBlock;

   const now = new Date();
   const dateString = now.toLocaleDateString('ro-RO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
   const responseActionList = isAdvancedMode
      ? '"click" | "type" | "key" | "scroll" | "wait" | "navigate" | "hold" | "drag" | "hover" | "inspectPage" | "findInPage" | "screenshot" | "recordVideo" | "closeTab" | "refresh" | "getLink" | "pasteLink" | "readClipboard" | "clear" | "goBack" | "goForward" | "listTabs" | "switchTab" | "newTab" | "listDownloads" | "waitForDownloads" | "ask" | "yield_control"'
      : '"click" | "type" | "key" | "scroll" | "wait" | "navigate" | "hold" | "drag" | "hover" | "inspectPage" | "findInPage" | "screenshot" | "recordVideo" | "closeTab" | "refresh" | "getLink" | "pasteLink" | "readClipboard" | "clear" | "goBack" | "goForward" | "listTabs" | "switchTab" | "newTab" | "listDownloads" | "waitForDownloads" | "done" | "ask" | "error" | "escalate"';
   const modeSpecificActionDocs = isAdvancedMode
      ? `- **ask**: Ask the user for clarification.
- **yield_control**: Yield control back to the Base Model. Use this when you have cleared the blocker and normal automation can resume. Never return \`escalate\` while in advanced mode.`
      : `- **done**: Task complete.
- **ask**: Ask the user for clarification.
- **error**: Report a bounded, non-recoverable failure after you tried the allowed recovery path. Include what was attempted and the observed status.
- **escalate**: Call the Advanced Reasoning Model. Don't hesitate to use this! Escalate whenever you feel stuck, trapped in a loop, repeat an action multiple times without success, or face complex visual challenges/captcha reasoning. You MUST provide a clear \`sub_objective\` for the advanced agent.`;
   const subObjectiveField = isAdvancedMode
      ? ''
      : '\n  "sub_objective": "<string>", // REQUIRED for \'escalate\' action';

   const advancedPrefix = isAdvancedMode
      ? `\n\n## 🚨 ROLE OVERRIDE: ADVANCED INTERVENTION AGENT 🚨\nYou are currently operating as the Advanced Intervention AI. You were summoned by the Base Agent because it got stuck.\nYour temporary goal is specifically to clear the blocker described in the Goal. However, use your own independent judgment. If the Goal suggests an action that does not make sense for the current visual state, adapt your approach.\n**CRITICAL INSTRUCTIONS:** \n- Think out of the box: if an expected element is missing, blank, or stuck loading, do not interact with empty space. Look for workarounds, close blocking overlays, or refresh the page.\n- Do NOT attempt to complete the user's entire task. Once you have cleared the immediate hurdle and the interface is ready for normal automation again, you MUST return the \`yield_control\` action. Do not return \`done\` or \`escalate\` in advanced mode.\n`
      : '';
   const coordinateInstructions = coordinateSpace === 'absolute-display'
      ? `2. You estimate ABSOLUTE PIXEL COORDINATES of the element you want to interact with.
   - The screenshot shows the full browser display, including tabs, address bar, toolbar, page content, popups, and context menus.
   - (0, 0) is the top-left pixel of the screenshot.
   - Use exact pixel coordinates within the screenshot dimensions shown in the frame metadata.
   - IMPORTANT: output coordinates ONLY for the final current frame.`
      : `2. You estimate the NORMALIZED COORDINATES (0-1000 range) of the element you want to interact with.
   - (0, 0) is the Top-Left corner.
   - (1000, 1000) is the Bottom-Right corner.
   - Example directly in the middle: [500, 500].
   - IMPORTANT: output coordinates ONLY for the final viewport frame, never for an overview frame.`;
   const coordinateAccuracyRule = coordinateSpace === 'absolute-display'
      ? '1. **Coordinate Accuracy**: Use absolute pixel coordinates from the final screenshot. Be precise, especially near the browser tab strip, address bar, menus, and small controls.'
      : '1. **Coordinate Accuracy**: Use the 1000x1000 grid system. Be precise.';
   const coordinateLabel = coordinateSpace === 'absolute-display' ? 'absolute pixel' : 'normalized';
   const coordinateComment = coordinateSpace === 'absolute-display'
      ? 'Absolute pixel coordinates in the current screenshot'
      : 'Normalized 0-1000';
   const usesFullDisplayBackend = coordinateSpace === 'absolute-display';
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
      ? '12. **When To Use inspectPage**: On the full-display backend, `inspectPage` is only another display capture. For exact text on long pages, prefer `findInPage`; for layout discovery, scroll visually and verify in the current frame.'
      : '12. **When To Use inspectPage**: Use `inspectPage` mainly for orientation on large pages. It is usually more helpful than blind repeated scrolling when the task is about scanning long result pages, comparing many sections, or finding content far away. If you already know where the target area is and need precise details, prefer viewport verification before requesting another overview.';

   return `You are an AI browser automation agent. You control a web browser by providing COORDINATES (x, y) to click.
Current Date: ${dateString}${advancedPrefix}

## 🤝 CONTINUED TASKS & REPLIES
If the Goal contains "[Previous Goal: ...]", it means the user is replying to you!
- User says "yes", "ok", "go ahead" → **COMBINE** with the previous goal/question.

## How It Works
1. You receive one or more screenshots of the page.
   - If multiple frames are provided, they are ordered oldest to newest.
   - The final frame is always the current viewport.
   - Earlier frames may include action traces or full-page overview captures.
${coordinateInstructions}
3. You return a JSON with the action and coordinates.

## Available Actions
- **click**: Click at specific (x, y) ${coordinateLabel} coordinates. Use \`clickCount: X\` to specify the number of rapid clicks (e.g., 2 for double-click, 3 to select paragraphs).
- **type**: Type text. Use \`clearBefore: true\` if needed. Set \`submit: true\` ONLY if you want to press Enter immediately.
- **key**: Press key (Enter, Escape, Tab, Backspace).
- **scroll**: Scroll up/down/left/right.
- **hover**: Hover mouse over (x, y). Useful for dropdowns/menus.
- **wait**: Wait for a specific duration. Specify \`durationMs\`.
- **navigate**: Go directly to a URL.
- **drag**: Click and drag from (x, y) to a second coordinate. Specify \`coordinate\` as start and \`coordinateEnd\` as the destination. You may also specify \`durationMs\` to control drag speed. Useful for sliders, drag-and-drop, and resizing. DO NOT use drag to scroll the page.
- **hold**: Long press at (x, y) for a specific duration. Specify \`durationMs\`.
${inspectPageDoc}
- **findInPage**: Open browser find (Ctrl+F), search exact text from \`text\`, and let the browser scroll to the match. Use this for long pages when you know a word, price, date, label, or phrase to locate. Set \`submit: true\` only when you intentionally want the next match.
- **screenshot**: Save the current visible viewport as evidence for the parent/user. Use this when the task asks for a screenshot, when visual proof is useful, or before asking for confirmation on a sensitive action. This does NOT interact with the page.
- **recordVideo**: Record the current visible viewport as evidence for a specific duration. Specify \`durationMs\` in milliseconds. Use this when the task asks for video or when motion/loading/animation matters. Recording blocks other actions while it captures; keep it short unless the user requested a longer duration.
- **refresh**: Reload the page.
- **closeTab**: Close a tab. If you provide \`tabIndex\`, it closes that tab even if it is not active. If omitted, it closes the current tab.
${getLinkDoc}
- **readClipboard**: Read the browser/OS clipboard and store it for later use. Use this after clicking a visible "Copy", "Copy link", "Copy key", or similar button when the task depends on the copied value or you need to paste it elsewhere.
- **pasteLink**: Type the stored clipboard/link content into the input at (x,y). If no link was stored through \`getLink\`, this can use the real browser clipboard read by \`readClipboard\` or a page Copy button.
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
3. **Login/Auth & Challenges**: If you need credentials, account choice, 2FA/codes, or a human-controlled login step, ASK the user for that narrow input or yield browser control. Do not guess, and do not frame login/signup as a refusal. If a browser challenge or captcha appears inside the authorized flow, first try ordinary in-session interaction using visible controls, coordinates, drag/hold, batch selection, refresh/retry, and \`escalate\` for complex visual reasoning. Do not use deception, external solving services, credential guessing, or mechanisms that defeat access-control/anti-bot systems. If the page requires human verification, 2FA/codes, credentials, or cannot be completed through legitimate browser interaction, ask/yield with the precise blocker. If the task is a free setup/API-key flow, continue reversible navigation and dashboard inspection, use existing sessions when available, and stop only at the actual commit/consent boundary. If an API key or token is visible as the requested setup result in an authorized account/dashboard, you may return the exact value in \`done.reasoning\` or \`ask.text\` when the goal asks to retrieve, copy, display, or configure it. Do not save keys/tokens to browser memory. Do not deliberately use \`screenshot\` or \`recordVideo\` just to capture a visible key unless the user or parent asks for visual evidence; this does not restrict the internal page frames you receive to operate or any automatic final-state capture made by the runtime.
4. **Cookie Consent**: If a cookie banner is present, click "Accept" or "OK" immediately.
5. **Forms/Reservations/Orders**: Ask user for any missing information before proceeding.
6. **Hard Commit Boundary**: NEVER click final payment, start a paid trial/subscription, place/cancel a final order, confirm/cancel a booking, send a message, perform an irreversible submit, change account/security settings, grant permissions, upload/submit sensitive personal documents/data to an external service, publicly share content, do destructive actions, submit account creation, or accept legal terms unless the delegated task explicitly confirms that exact final action. If confirmation is missing, stop with \`ask\` and include the exact action, visible details, URL, and a screenshot if useful.
   - Free setup/API-key flows are allowed up to that boundary. Do not refuse just because signup/login may be involved. Navigate, inspect pricing, locate free plan/dashboard/API key pages, use existing logged-in sessions, ask which account/sign-in method to use when unclear, and fill non-sensitive fields when the task contract provides them. Stop only before final account creation, legal terms acceptance, permission grant, personal-data submission, paid trial/subscription, or payment. When the key is already visible after authorized login/setup, return the key value if the task asks for it, or return the key plus intended env var name if the parent needs to store it.
7. **Evidence**: When the user or parent asks for a screenshot/video, use \`screenshot\` or \`recordVideo\` yourself. Also use \`screenshot\` before asking for confirmation on purchases, bookings, sends, uploads, or other sensitive boundaries. Evidence-action rules do not apply to the internal screenshots you receive for browser control. When your final \`done\`/\`ask\`/\`error\` message mentions captured evidence, say that it was captured; do not invent or cite image filenames/links. The parent app attaches captured media inline.
8. **Data Gathering**: Do not be afraid to scroll and explore the whole page to find the information you need.
9. **Search Results**: If the search results are not what you expected, try to refine the search query or try a different approach. Or maybe just what you searched for is not available on the site.
10. **Popup & Modal Scrolling**: If a popup, modal, or specific container has its own internal scroll, you MUST click inside it first before using the scroll action. If you used 'scroll' and notice only the background page moved but the modal didn't, you failed because the modal wasn't focused. BATCH a "click" inside the modal + "scroll" to fix it.
11. **Overview Frames**: If a frame says \`Capture: overview\`, it shows the full page for orientation only. Use it to decide where to scroll, not where to click.
${inspectPageRule}
13. **Batching inspectPage/evidence**: Do NOT batch \`inspectPage\`, \`screenshot\`, or \`recordVideo\` with page-changing actions. Capture first, then act after you see the next frame.
14. **Reading From Overview**: You MAY use an overview frame to answer high-level questions about what sections, result groups, posters, cards, or major items appear on the page. If text is too small or ambiguous, scroll closer and verify in the viewport before making precise claims.
15. **Scroll Estimation From Overview**: When using an overview frame, estimate scrolls approximately to move the viewport near the target area, then refine with one or two smaller viewport-based scrolls. Do not assume pixel-perfect precision from an overview image.
16. **Clipboard Verification**: If you click a Copy button and the copied value matters, use \`readClipboard\` as the next action before returning \`done\` or trying to paste it.

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
1. **Loop Detection**: If you repeat the same actions with no progress, STOP. Escalate to the advanced agent if you feel stuck.
2. **Scroll if needed**: If you don't see what you need, SCROLL.
3. **Handle Stuck States**: If an action fails multiple times, try finding unselected fields, check focus, or use **refresh**. If an expected element is visibly unfinished, blank, or stuck loading, DO NOT interact with empty space. Search for a close button, a fallback option, or rethink the approach.
4. **Long Task Continuity**: Treat earlier action summaries as completed work. Do not restart from the original checklist just because the task is long; verify the current file/page and continue from the latest unfinished step.
5. **Learn from Mistakes**: If you correct an error or find a workaround, add a "memory" field to your JSON.
   - Example: "Search boxes on this site need a click before typing."
   - Only save reusable interaction rules or domain-specific UI behaviors.
   - Do not save one-off task outcomes, captcha-specific instructions, button labels, or temporary page states.
   - Do not add memory for every action, only for significant ones.
   - Do not repeat the same memory.

${learningsText}

## 🔀 BATCH ACTIONS
When you can determine multiple actions from the current screenshot (e.g. selecting multiple CAPTCHA images, filling several form fields, clicking multiple checkboxes), return an ARRAY of actions instead of a single one.
Rules for batching:
- Only batch actions that do NOT depend on page changes between them.
- NEVER include page-changing actions in a batch (submit buttons, "Verify", "Next", "Confirm", navigate, form submission). Do the batch first, then after verifying the result in the next screenshot, submit as a separate action.
- Prefer not to batch actions when the later action depends on seeing the result of the earlier one, especially after \`scroll\`, \`switchTab\`, \`inspectPage\`, \`findInPage\`, \`closeTab\`, or download/export clicks. Run \`waitForDownloads\` as its own later action.
- If unsure whether batching is safe, just return a single action.
- **Fail-Safe**: If you attempted a batch previously and it failed or didn't work as expected, DO NOT batch again for those elements. Fall back to doing ONE action per turn (sequentially) to let the page settle.

## Response Format - JSON ONLY
Single action:
{
  "action": ${responseActionList},
  "coordinate": [x, y],  // ${coordinateComment}
  "coordinateEnd": [x, y], // ${coordinateComment}, end point for drag action
  "clickCount": <number>, // Optional, default 1, can be any number for multiple rapid clicks
  "text": "<text for type>",
  "submit": true | false, // Press Enter after typing?
  "clearBefore": true | false, // Clear input before typing?
  "key": "Enter" | "Escape" | "Tab" | "Backspace",
  "scrollDirection": "up" | "down" | "left" | "right",
  "scrollAmount": <number>, // Optional, pixels to scroll. Default is 500 (half page). Use larger values (e.g. 1000) to jump large sections.
  "url": "<url for navigate or newTab action>",
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

function formatActionHistory(recentActions: ActionHistoryItem[], totalActions = recentActions.length, startIndex = 0): string {
   if (recentActions.length === 0) {
      return '';
   }

   let historyText = '\n## 📜 ACTION HISTORY (newest last):\n' + recentActions
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
         if (a.expectedFilename) desc += ` expected="${a.expectedFilename.substring(0, 60)}"`;
         desc += a.success ? ' ✓' : ' ✗ FAILED';
         if (a.reasoning) desc += `\n         → Reason: "${redactBrowserAgentText(a.reasoning).substring(0, 80)}"`;
         if (a.observation) desc += `\n         → Result: "${redactBrowserAgentText(a.observation).substring(0, 500)}"`;
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
      return `Step ${step}: ${a.action}${text} ${status}${reason}`;
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
   downloads?: BrowserDownloadFile[]
): string {
   const recentActions = actionHistory.slice(-ACTION_HISTORY_PROMPT_LIMIT);
   const earlierActions = actionHistory.slice(0, Math.max(0, actionHistory.length - ACTION_HISTORY_PROMPT_LIMIT));

   // Detect loops (simplified for coordinates)
   let loopWarning = '';
   if (recentActions.length >= 4) {
      const last4 = recentActions.slice(-4);

      const coords = last4.map(a => a.coordinate ? `${a.coordinate[0]},${a.coordinate[1]}` : null).filter(c => c !== null);

      // 1. Detect alternating loops (A-B-A-B)
      const isAlternating = coords.length >= 4 && coords[0] === coords[2] && coords[1] === coords[3] && coords[0] !== coords[1];

      // 2. Detect repeating loops (A-A-A-A), carefully excluding safe/intentional actions like scrolling/waiting
      const isRepeating = last4.length === 4 && last4.every(a =>
         a.action === last4[0].action &&
         ['click', 'type', 'drag', 'hold'].includes(a.action) &&
         a.coordinate && last4[0].coordinate &&
         a.coordinate[0] === last4[0].coordinate[0] &&
         a.coordinate[1] === last4[0].coordinate[1]
      );

      if (isAlternating || isRepeating) {
         loopWarning = `\n\n## ⚠️ LOOP DETECTED! ⚠️\nYou are stuck! Repeating the same failed actions without making progress!\n**STOP trying the exact same thing!** Consider: checking for unselected mandatory fields (allergies/checkboxes), scrolling inside modals by clicking them first, doing something completely different, or immediately using the "escalate" action to let the Advanced Agent take over.\n`;
      }
   }

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

   return `## 🎯 GOAL: ${goal}
${loopWarning}${tabContext}${downloadContext}${earlierSummary}${historyText}

## ⚠️ BEFORE YOU ACT:
1. Review history.
2. Estimate NORMALIZED COORDINATES (0-1000) based only on the final viewport frame.
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
You have used all allowed automation turns for this task and did NOT finish it.
Do NOT suggest another browser action. Do NOT return an automation action. Analyze what happened and help the user understand the failure mode.

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

export function buildActionHistoryCompactionPrompt(
   goal: string,
   actionsToCompact: ActionHistoryItem[],
   conversationHistory: string[],
   keepLastCount: number
): string {
   const historyText = formatActionHistory(actionsToCompact, actionsToCompact.length, 0);
   const priorContext = conversationHistory.length > 0
      ? `\n## EXISTING COMPACTED / CONVERSATION CONTEXT\n${conversationHistory.map((entry) => redactBrowserAgentText(entry)).join('\n')}\n`
      : '';

   return `## BROWSER ACTION HISTORY COMPACTION
You are compacting older browser-agent action history so the agent can continue a long task.
The live prompt will keep the latest ${keepLastCount} actions separately; summarize ONLY the older actions below.

## ORIGINAL GOAL
${redactBrowserAgentText(goal)}
${priorContext}
${historyText}

Return JSON only with this exact shape:
{
  "summary": "<compact but specific paragraph>",
  "completed": ["<important completed step>", "<important completed step>"],
  "currentState": "<last known relevant page/file/state from this older history>",
  "avoidRepeating": ["<step the agent should not redo unless verified missing>"],
  "openRisks": ["<uncertainty, failed step, or thing still needing verification>"]
}

Rules:
- Preserve task-critical facts: files opened or edited, buttons clicked to save, sections already searched, entities/forms/settings already touched, failed attempts, and any user-imposed boundaries.
- For config/editor tasks, explicitly note which file or setting was already edited or saved if the action history supports that.
- Do not include passwords, bearer tokens, API keys, webhook secrets, auth headers, or raw credential values. Write "[redacted]" if a secret was involved.
- Do not invent success that the action history does not support; distinguish "typed/clicked save" from "verified saved" when verification is absent.
- Keep it short enough to fit as durable context in future prompts.
- JSON only.`;
}


export function buildInterruptPrompt(
   newGoal: string
): string {
   return `## ⚡ NEW GOAL (previous cancelled): ${newGoal}

Start working on the new goal. JSON only:`;
}
