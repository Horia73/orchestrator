// Google Calendar operating doctrine. Loaded lazily with the Calendar tool
// schemas after ActivateIntegrationTools("google-calendar").
export const GOOGLE_CALENDAR_DOCTRINE = `
<google_calendar_capability>
Use Google Calendar as an operating workflow, not only as a list of event CRUD tools. Read first, reason over explicit local-day boundaries, and mutate only after the user has approved the exact change.

<common_read_protocol>
- Resolve the account/default connection, user timezone, requested date window, and inclusive/exclusive boundaries before querying. Treat phrases such as "today" and "tomorrow" in the user's configured timezone.
- Use GoogleCalendarListEvents for a bounded period, GoogleCalendarSearchEvents for a named topic/person, GoogleCalendarGetEvent for authoritative event details, GoogleCalendarFreeBusy for busy intervals, and GoogleCalendarFindAvailability for candidate slots.
- Treat opaque timed events as busy even when their title/details are hidden. Treat all-day transparent events as context rather than occupied time. Do not infer availability from titles alone.
- Preserve event ids, calendar ids, timezones, recurrence, attendee status, conference links, location, description, attachments, and source calendar when they affect the answer.
- When linked Drive/Docs/Sheets/Slides material matters, activate Google Workspace and inspect only the relevant linked items. Do not broaden into unrelated mailbox or web research unless the user asks.
</common_read_protocol>

<daily_brief>
For a daily agenda or brief:
1. Query exactly one local calendar day across the relevant calendars.
2. Separate all-day context from timed events; order timed events chronologically.
3. Flag overlaps, too-tight transitions, travel/location conflicts, missing links, and events awaiting the user's response.
4. Derive useful free windows from the actual busy intervals. For "remaining today", exclude elapsed time.
5. Return a compact answer: date/timezone, all-day context, agenda, conflict/prep flags, and meaningful free windows. Do not dump raw event JSON.
</daily_brief>

<meeting_prep>
For meeting preparation:
1. Resolve the exact event and read its full details.
2. Inspect linked notes or documents when accessible, plus nearby or recurring instances only when they clarify continuity.
3. State the likely purpose, participants, decisions/questions, required reading, and missing context. Distinguish facts from inference.
4. End with a short prioritized preparation checklist. Do not invent an agenda from a vague title.
</meeting_prep>

<group_scheduling>
For scheduling multiple people, establish the window, duration, timezone, required versus optional attendees, working-hour constraints, and any hard exclusions. Use GoogleCalendarFreeBusy/GoogleCalendarFindAvailability, then rank 2-4 strong slots by required-attendee coverage, timezone fairness, fragmentation, and proximity to surrounding commitments. If no perfect slot exists, state exactly who or which constraint each compromise affects. Check rooms/resources only after viable attendee slots exist.
</group_scheduling>

<free_up_time>
When the user wants focus time, optimize for one useful contiguous block rather than the largest total of scattered minutes. Classify fixed anchors versus plausibly movable events from evidence; protect external commitments, hard deadlines, lunch/personal anchors, and travel buffers. Propose the smallest edit set with a before/after view and explain the tradeoff. Never move or delete events merely because their titles look flexible.
</free_up_time>

<writes_and_confirmation>
- Read-only briefs, prep, free/busy checks, and proposals need no confirmation.
- Before GoogleCalendarCreateEvent, GoogleCalendarUpdateEvent, GoogleCalendarMoveEvent, GoogleCalendarDeleteEvent, or GoogleCalendarRespondToEvent, show the exact calendar, title/event, local date/time/timezone, attendees, recurrence impact, and the requested action. Obtain explicit confirmation and pass \`confirmed_by_user=true\`.
- A scheduling proposal is not authorization. If details are ambiguous or a recurring series could be affected, resolve that ambiguity before writing.
- After a write, report the authoritative result and any per-item failures. Do not claim an event changed until the tool confirms it.
</writes_and_confirmation>

Keep outputs practical and selective. Lead with the answer, surface conflicts and uncertainty, and avoid listing every empty gap or repeating metadata that does not change the decision.
</google_calendar_capability>
`.trim()
