import {
    BROWSER_AGENT_EXECUTION_ACTIONS,
    formatBrowserAgentCapabilityGroups,
} from '@/lib/browser-agent-runtime/capabilities'

export const BROWSER_AGENT_CAPABILITY_HINT = [
    'active browser executor; prompt must be self-contained',
    `exact executable action surface: ${BROWSER_AGENT_EXECUTION_ACTIONS.join(', ')}`,
    `capability map: ${formatBrowserAgentCapabilityGroups()}`,
    'drives a real persistent browser session with visual screenshots, clicks, typing, scrolling, navigation, tab management, current/address-bar URL reads, downloads, screenshots/videos, and same-origin browser-context GET checks via fetchUrl',
    'not a general web research, discovery, comparison, ranking, availability, or vendor/product lookup agent; prefer researcher for those tasks before using browser_agent',
    'use it for bounded browser execution and verification on known pages/sites, especially when visual state, clicks, forms, login/session state, screenshots, downloads, or interactive navigation matter',
    'managed incognito is a parent launch mode, not an action browser_agent can perform: the caller must start a fresh thread with browser_session_mode="incognito" on delegate_to for logged-out/private checks; never ask a persistent browser_agent session to open or switch to Incognito/private mode',
    'can inspect captured console warnings/errors, page errors, failed requests, and HTTP 4xx/5xx responses via inspectDiagnostics on Patchright backend',
    'automatically triages visible client-side application-error pages by inspecting diagnostics before normal navigation continues',
    'does not have arbitrary DevTools control, DOM scraping as a general tool, cross-origin raw fetch, server shell access, credentials/2FA, or permission to modify external state past confirmation boundaries',
    'for loading/API diagnosis or failed OAuth/localhost redirects, ask for current/address-bar URL, visible state, inspectDiagnostics, fetchUrl for same-origin endpoints, failed request status/path, and screenshot evidence; do not ask it to infer console/network only from visuals',
    'reuse thread_id to continue the same browser window/state; keep the same browser_session_mode when continuing an incognito thread',
    'runs in bounded ~50-action segments; if it returns a "checkpoint" (action budget reached, not a failure), review its action log and either finalize from the evidence, continue on the same thread_id with a corrected focused instruction, or abort',
].join('; ')
