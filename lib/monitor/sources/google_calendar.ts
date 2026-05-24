import { resolveAppOrigin } from '@/lib/app-origin'
import type { GoogleCalendarEventSummary } from '@/lib/integrations/google-calendar'

import { evaluateRule, type GoogleCalendarCandidate } from '../rules'
import type { MonitorWatch, WatchState } from '../schema'
import {
    extractCalendarIdsFromRule,
    extractCalendarLookaheadDaysFromRule,
    matchingCalendarStartWindows,
} from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// Google Calendar source adapter.
//
// Calendar watches are primed like Gmail/WhatsApp: the first tick records the
// existing upcoming events and produces no matches. Later ticks surface:
//   - new or updated events that satisfy the watch rule, or
//   - matching events entering a calendar_event_starts_within window.
//
// This avoids blasting the user with their existing schedule while still
// supporting useful "tell me when an onboarding event appears/changes" and
// "remind me 30m before X" watches.
// ---------------------------------------------------------------------------

const CALENDAR_KEY = 'google_calendar'
const DEFAULT_LOOKAHEAD_DAYS = 30
const MAX_LOOKAHEAD_DAYS = 90
const MAX_CALENDARS = 25
const MAX_EVENTS_PER_CALENDAR = 75
const START_KEY_RING_CAP = 500

interface CalendarEventMemory {
    fingerprint: string
    lastSeenAt: number
}

interface CalendarExtra {
    primed?: boolean
    events?: Record<string, CalendarEventMemory>
    startNotifiedKeys?: string[]
}

function readCalendarExtra(state: WatchState): CalendarExtra {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[CALENDAR_KEY]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as CalendarExtra
}

function mergeCalendarExtra(state: WatchState, patch: CalendarExtra): Record<string, unknown> {
    const next = { ...(state.extra ?? {}) } as Record<string, unknown>
    const prev = readCalendarExtra(state)
    next[CALENDAR_KEY] = {
        primed: patch.primed ?? prev.primed ?? false,
        events: patch.events ?? prev.events ?? {},
        startNotifiedKeys: patch.startNotifiedKeys ?? prev.startNotifiedKeys ?? [],
    } satisfies CalendarExtra
    return next
}

export const googleCalendarSourceAdapter: SourceAdapter = {
    source: 'google_calendar',
    supportedRuleKinds: [
        'calendar_event_title_contains',
        'calendar_event_description_contains',
        'calendar_event_location_contains',
        'calendar_event_attendee',
        'calendar_event_needs_response',
        'calendar_event_starts_within',
        'calendar_event_query',
    ],
    supportedActionKinds: ['notify_inbox'],

    async isAvailable(): Promise<AvailabilityResult> {
        try {
            const { getGoogleCalendarIntegrationStatus } = await import('@/lib/integrations/google-calendar')
            const status = await getGoogleCalendarIntegrationStatus(resolveAppOrigin(), true)
            if (!status.configured) return { available: false, reason: 'Google Calendar OAuth not configured.' }
            if (!status.connected) return { available: false, reason: 'Google Calendar not connected — sign in to resume.' }
            if (status.needsReconnect) return { available: false, reason: 'Google Calendar token expired or scopes changed — reconnect to resume.' }
            return { available: true }
        } catch (err) {
            return { available: false, reason: err instanceof Error ? err.message : 'Google Calendar status check failed.' }
        }
    },

    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('google_calendar', async () => {
            const { watch, now, timeoutMs } = input
            const extra = readCalendarExtra(watch.state)
            const priming = !extra.primed
            const calendarIds = await resolveCalendarIds(watch, timeoutMs)
            if (calendarIds.length === 0) {
                return {
                    ok: false,
                    error: 'Google Calendar watch has no readable calendars.',
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {},
                    fetchedAt: now,
                }
            }

            const lookaheadDays = calendarLookaheadDays(watch)
            const timeMin = new Date(now - 60 * 60 * 1000).toISOString()
            const timeMax = new Date(now + lookaheadDays * 24 * 60 * 60 * 1000).toISOString()
            const perCalendarBudget = Math.max(1500, Math.floor(timeoutMs / Math.max(1, calendarIds.length)))
            const nextEvents: Record<string, CalendarEventMemory> = {}
            const previousEvents = extra.events ?? {}
            const previousStartKeys = extra.startNotifiedKeys ?? []
            const startKeys = new Set(previousStartKeys)
            const newStartKeys: string[] = []
            const matches: MatchedCandidate[] = []
            const errors: string[] = []
            let candidatesSeen = 0

            const { googleCalendarListEvents } = await import('@/lib/integrations/google-calendar')

            for (const calendarId of calendarIds) {
                try {
                    const result = await withTimeout(
                        googleCalendarListEvents({
                            calendarId,
                            timeMin,
                            timeMax,
                            maxResults: MAX_EVENTS_PER_CALENDAR,
                            singleEvents: true,
                            showDeleted: true,
                        }),
                        perCalendarBudget,
                        `Google Calendar listEvents ${calendarId}`,
                    )

                    for (const event of result.events) {
                        candidatesSeen += 1
                        const key = eventKey(event)
                        const previous = previousEvents[key]
                        const candidate = buildCandidate(event, previous?.fingerprint ?? null, now)
                        nextEvents[key] = {
                            fingerprint: candidate.fingerprint,
                            lastSeenAt: now,
                        }

                        const ruleMatched = evaluateRule(watch.rule, candidate)
                        if (!ruleMatched) continue

                        const matchedStartKeys = matchingCalendarStartWindows(
                            watch.rule,
                            candidate.minutesUntilStart,
                        ).map((minutes) => startWindowKey(candidate, minutes))

                        if (priming) {
                            for (const startKey of matchedStartKeys) startKeys.add(startKey)
                            continue
                        }

                        const freshStartKeys = matchedStartKeys.filter((startKey) => !startKeys.has(startKey))
                        const changed = candidate.isNew || candidate.isUpdated
                        if (!changed && freshStartKeys.length === 0) continue

                        for (const startKey of freshStartKeys) {
                            startKeys.add(startKey)
                            newStartKeys.push(startKey)
                        }

                        matches.push({
                            candidate,
                            summary: calendarSummary(candidate, freshStartKeys.length > 0),
                            externalId: key,
                            details: {
                                calendarId: candidate.calendarId,
                                eventId: candidate.eventId,
                                status: candidate.status,
                                title: candidate.summary,
                                start: candidate.start,
                                end: candidate.end,
                                allDay: candidate.allDay,
                                location: candidate.location || null,
                                htmlLink: candidate.htmlLink || null,
                                selfResponseStatus: candidate.selfResponseStatus,
                                minutesUntilStart: candidate.minutesUntilStart,
                                isNew: candidate.isNew,
                                isUpdated: candidate.isUpdated,
                                startsWithinWindow: freshStartKeys.length > 0,
                            },
                        })
                    }
                } catch (err) {
                    errors.push(err instanceof Error ? `${calendarId}: ${err.message}` : `${calendarId}: ${String(err)}`)
                }
            }

            const mergedStartKeys = [
                ...newStartKeys,
                ...[...startKeys].filter((key) => !newStartKeys.includes(key)),
            ].slice(0, START_KEY_RING_CAP)

            return {
                ok: errors.length === 0,
                error: errors.length > 0 ? errors.join('; ') : undefined,
                matches,
                candidatesSeen,
                stateUpdate: {
                    lastFetchedAt: now,
                    extra: mergeCalendarExtra(watch.state, {
                        primed: true,
                        events: nextEvents,
                        startNotifiedKeys: mergedStartKeys,
                    }),
                },
                fetchedAt: now,
            }
        })
    },
}

async function resolveCalendarIds(watch: MonitorWatch, timeoutMs: number): Promise<string[]> {
    const ruleIds = extractCalendarIdsFromRule(watch.rule)
    if (ruleIds.length > 0) return unique(ruleIds).slice(0, MAX_CALENDARS)

    const target = watch.target.trim()
    const normalizedTarget = target.toLowerCase()
    if (normalizedTarget === 'all' || normalizedTarget === 'visible' || normalizedTarget === 'selected') {
        const { googleCalendarListCalendars } = await import('@/lib/integrations/google-calendar')
        const result = await withTimeout(
            googleCalendarListCalendars({ maxResults: MAX_CALENDARS }),
            timeoutMs,
            'Google Calendar listCalendars',
        )
        const calendars = normalizedTarget === 'selected'
            ? result.calendars.filter((calendar) => calendar.selected && !calendar.hidden)
            : result.calendars.filter((calendar) => !calendar.hidden)
        return calendars.map((calendar) => calendar.id).slice(0, MAX_CALENDARS)
    }

    const explicit = target.split(',').map((part) => part.trim()).filter(Boolean)
    return unique(explicit.length > 0 ? explicit : ['primary']).slice(0, MAX_CALENDARS)
}

function calendarLookaheadDays(watch: MonitorWatch): number {
    const requested = extractCalendarLookaheadDaysFromRule(watch.rule) ?? DEFAULT_LOOKAHEAD_DAYS
    return Math.max(1, Math.min(MAX_LOOKAHEAD_DAYS, requested))
}

function buildCandidate(
    event: GoogleCalendarEventSummary,
    previousFingerprint: string | null,
    now: number,
): GoogleCalendarCandidate {
    const startMs = parseTime(event.start)
    const endMs = parseTime(event.end)
    const fingerprint = eventFingerprint(event)
    const selfAttendee = event.attendees.find((attendee) => attendee.self)
    return {
        source: 'google_calendar',
        calendarId: event.calendarId,
        eventId: event.id,
        htmlLink: event.htmlLink,
        status: event.status,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
        startMs,
        endMs,
        updated: event.updated,
        eventType: event.eventType,
        creator: event.creator,
        organizer: event.organizer,
        attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            displayName: attendee.displayName,
            responseStatus: attendee.responseStatus,
            self: attendee.self,
        })),
        selfResponseStatus: selfAttendee?.responseStatus ?? null,
        minutesUntilStart: startMs === null ? null : Math.floor((startMs - now) / 60_000),
        fingerprint,
        previousFingerprint,
        isNew: previousFingerprint === null,
        isUpdated: previousFingerprint !== null && previousFingerprint !== fingerprint,
    }
}

function eventKey(event: Pick<GoogleCalendarEventSummary, 'calendarId' | 'id' | 'start'>): string {
    return `${event.calendarId}:${event.id}:${event.start}`
}

function startWindowKey(candidate: GoogleCalendarCandidate, minutes: number): string {
    return `${candidate.calendarId}:${candidate.eventId}:${candidate.start}:starts_within:${minutes}`
}

function calendarSummary(candidate: GoogleCalendarCandidate, startsSoon: boolean): string {
    const start = candidate.start || '(no start)'
    const bits = [
        candidate.summary || '(No title)',
        start,
        candidate.location ? `@ ${candidate.location}` : '',
    ].filter(Boolean)
    return startsSoon ? `Starts soon: ${bits.join(' ')}` : bits.join(' ')
}

function eventFingerprint(event: GoogleCalendarEventSummary): string {
    return JSON.stringify({
        status: event.status,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        updated: event.updated,
        attendees: event.attendees.map((attendee) => ({
            email: attendee.email,
            displayName: attendee.displayName,
            responseStatus: attendee.responseStatus,
            optional: attendee.optional,
        })),
        reminders: event.reminders,
        recurrence: event.recurrence,
    })
}

function parseTime(value: string): number | null {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
