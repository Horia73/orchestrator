import path from 'path'
import { randomBytes } from 'crypto'

import { PRIVATE_STATE_DIR } from '@/lib/config'
import {
    GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS,
    type GoogleOAuthConfigInput,
    type GoogleOAuthProviderConfig,
    type GoogleOAuthTokenRecord,
    clearGoogleOAuthToken,
    exchangeGoogleOAuthCode,
    getGoogleOAuthConfig,
    missingGoogleScopes,
    parseScopeList,
    readGoogleOAuthToken,
    refreshGoogleOAuthToken,
    responseErrorText,
    revokeGoogleOAuthToken,
    saveGoogleOAuthClientConfig,
    startGoogleOAuth,
    writeGoogleOAuthToken,
} from './google-oauth'

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_CALENDAR_TOKEN_PATH = path.join(PRIVATE_STATE_DIR, 'auth', 'google-calendar.json')
const DEFAULT_ORIGIN = 'http://localhost:3000'

export const GOOGLE_CALENDAR_PROVIDER: GoogleOAuthProviderConfig = {
    provider: 'googleCalendar',
    label: 'Google Calendar',
    redirectPath: '/api/integrations/google/oauth/callback',
    tokenPath: GOOGLE_CALENDAR_TOKEN_PATH,
    clientIdEnvKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CALENDAR_OAUTH_CLIENT_ID', 'CALENDAR_OAUTH_CLIENT_ID'],
    clientSecretEnvKeys: ['GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET', 'CALENDAR_OAUTH_CLIENT_SECRET'],
    redirectUriEnvKeys: [
        'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI',
        'GOOGLE_CALENDAR_OAUTH_REDIRECT_URI',
        'CALENDAR_OAUTH_REDIRECT_URI',
    ],
    writeRedirectUriKey: 'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI',
}

export const GOOGLE_CALENDAR_SCOPES = [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/calendar.settings.readonly',
] as const

const ACCESS_ROLE_ORDER = ['freeBusyReader', 'reader', 'writer', 'owner'] as const
const DEFAULT_EVENT_MAX_RESULTS = 50
const MAX_EVENT_MAX_RESULTS = 250
const MAX_CALENDAR_MAX_RESULTS = 250
const MAX_AVAILABILITY_ITERATIONS = 50_000

export interface GoogleCalendarIntegrationStatus {
    id: 'googleCalendar'
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    calendarCount: number | null
    writableCalendarCount: number | null
    primaryCalendarId: string | null
    primaryCalendarSummary: string | null
    timeZone: string | null
    capabilities: string[]
    error?: string
}

export interface GoogleCalendarListOptions {
    maxResults?: number
    minAccessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner'
    showHidden?: boolean
    showDeleted?: boolean
}

export interface GoogleCalendarEventListOptions {
    calendarId?: string
    timeMin?: string
    timeMax?: string
    query?: string
    maxResults?: number
    singleEvents?: boolean
    orderBy?: 'startTime' | 'updated'
    showDeleted?: boolean
    timeZone?: string
    eventTypes?: string[]
}

export interface GoogleCalendarSearchOptions {
    query: string
    calendarIds?: string[]
    timeMin?: string
    timeMax?: string
    maxResultsPerCalendar?: number
    includeReadOnlyCalendars?: boolean
}

export interface GoogleCalendarFreeBusyOptions {
    calendarIds: string[]
    timeMin: string
    timeMax: string
    timeZone?: string
}

export interface GoogleCalendarAvailabilityOptions extends GoogleCalendarFreeBusyOptions {
    durationMinutes: number
    slotStepMinutes?: number
    workdayStart?: string
    workdayEnd?: string
    daysOfWeek?: number[]
    maxResults?: number
}

export interface GoogleCalendarEventInput {
    calendarId?: string
    summary?: string
    description?: string
    location?: string
    startDate?: string
    endDate?: string
    startDateTime?: string
    endDateTime?: string
    timeZone?: string
    attendees?: string[]
    optionalAttendees?: string[]
    recurrence?: string[]
    transparency?: 'opaque' | 'transparent'
    visibility?: 'default' | 'public' | 'private' | 'confidential'
    colorId?: string
    reminders?: GoogleCalendarReminderInput
    createMeet?: boolean
    guestsCanModify?: boolean
    guestsCanInviteOthers?: boolean
    guestsCanSeeOtherGuests?: boolean
}

export interface GoogleCalendarReminderInput {
    useDefault?: boolean
    overrides?: Array<{ method: 'email' | 'popup'; minutes: number }>
}

export interface GoogleCalendarEventWriteOptions {
    sendUpdates?: 'all' | 'externalOnly' | 'none'
}

export interface GoogleCalendarEventSummary {
    calendarId: string
    id: string
    status: string
    htmlLink: string
    summary: string
    description: string
    location: string
    start: string
    end: string
    allDay: boolean
    timeZone: string | null
    created: string | null
    updated: string | null
    creator: CalendarPerson | null
    organizer: CalendarPerson | null
    attendees: CalendarAttendeeSummary[]
    recurrence: string[]
    recurringEventId: string | null
    originalStartTime: string | null
    transparency: string | null
    visibility: string | null
    eventType: string | null
    hangoutLink: string | null
    conference: CalendarConferenceSummary | null
    reminders: GoogleCalendarReminderInput | null
}

export interface GoogleCalendarInfo {
    id: string
    summary: string
    description: string
    primary: boolean
    timeZone: string | null
    accessRole: string
    selected: boolean
    hidden: boolean
    backgroundColor: string | null
    foregroundColor: string | null
    canWriteEvents: boolean
    conferenceTypes: string[]
}

interface CalendarPerson {
    email: string
    displayName: string
    self: boolean
}

interface CalendarAttendeeSummary extends CalendarPerson {
    responseStatus: string
    optional: boolean
    organizer: boolean
    resource: boolean
}

interface CalendarConferenceSummary {
    conferenceId: string
    entryPoints: Array<{ type: string; uri: string; label: string }>
}

interface CalendarListResponse {
    nextPageToken?: string
    items?: CalendarListEntry[]
}

interface CalendarListEntry {
    id: string
    summary?: string
    description?: string
    primary?: boolean
    timeZone?: string
    accessRole?: string
    selected?: boolean
    hidden?: boolean
    backgroundColor?: string
    foregroundColor?: string
    conferenceProperties?: {
        allowedConferenceSolutionTypes?: string[]
    }
}

interface CalendarEventsResponse {
    nextPageToken?: string
    items?: CalendarEvent[]
}

interface CalendarEvent {
    id: string
    status?: string
    htmlLink?: string
    summary?: string
    description?: string
    location?: string
    created?: string
    updated?: string
    start?: CalendarEventDate
    end?: CalendarEventDate
    creator?: CalendarEventPerson
    organizer?: CalendarEventPerson
    attendees?: CalendarEventAttendee[]
    recurrence?: string[]
    recurringEventId?: string
    originalStartTime?: CalendarEventDate
    transparency?: string
    visibility?: string
    eventType?: string
    hangoutLink?: string
    conferenceData?: {
        conferenceId?: string
        entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>
    }
    reminders?: GoogleCalendarReminderInput
}

interface CalendarEventDate {
    date?: string
    dateTime?: string
    timeZone?: string
}

interface CalendarEventPerson {
    email?: string
    displayName?: string
    self?: boolean
}

interface CalendarEventAttendee extends CalendarEventPerson {
    responseStatus?: string
    optional?: boolean
    organizer?: boolean
    resource?: boolean
}

interface FreeBusyResponse {
    timeMin?: string
    timeMax?: string
    groups?: Record<string, { errors?: unknown[]; calendars?: string[] }>
    calendars?: Record<string, { errors?: unknown[]; busy?: Array<{ start: string; end: string }> }>
}

export async function getGoogleCalendarIntegrationStatus(origin: string, refresh = true): Promise<GoogleCalendarIntegrationStatus> {
    const config = getGoogleOAuthConfig(origin, GOOGLE_CALENDAR_PROVIDER)
    let token = readCalendarToken()
    let error: string | undefined

    const shouldRefresh = token ? token.expiresAt <= Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS : false
    if (refresh && shouldRefresh && token?.refreshToken && config.clientId && config.clientSecret) {
        try {
            token = await refreshGoogleOAuthToken(token, config, GOOGLE_CALENDAR_TOKEN_PATH)
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to refresh Google Calendar token'
        }
    }

    const scopes = token?.scope ?? []
    const missingScopes = missingGoogleScopes(scopes, GOOGLE_CALENDAR_SCOPES)
    const expired = token ? token.expiresAt <= Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS : false
    let calendars: GoogleCalendarInfo[] | null = null

    if (token && missingScopes.length === 0 && !expired) {
        try {
            calendars = (await googleCalendarListCalendars({ maxResults: 100 })).calendars
        } catch (err) {
            error = err instanceof Error ? err.message : 'Could not read Google Calendar list.'
        }
    }

    const primary = calendars?.find(calendar => calendar.primary) ?? null
    const accountEmail = token?.accountEmail || inferAccountEmail(primary?.id ?? null)

    return {
        id: 'googleCalendar',
        name: 'Google Calendar',
        description: 'Read availability and events, then create, update, move, RSVP, and delete events after explicit approval.',
        configured: config.missing.length === 0,
        connected: Boolean(token?.accessToken || token?.refreshToken),
        accountEmail,
        scopes,
        requestedScopes: [...GOOGLE_CALENDAR_SCOPES],
        missingConfig: config.missing,
        redirectUri: config.redirectUri,
        expiresAt: token?.expiresAt ?? null,
        needsReconnect: Boolean(!token || missingScopes.length > 0 || (expired && !token.refreshToken)),
        calendarCount: calendars ? calendars.length : null,
        writableCalendarCount: calendars ? calendars.filter(calendar => calendar.canWriteEvents).length : null,
        primaryCalendarId: primary?.id ?? null,
        primaryCalendarSummary: primary?.summary ?? null,
        timeZone: primary?.timeZone ?? null,
        capabilities: [
            'list_calendars',
            'list_events',
            'search_events',
            'free_busy',
            'find_availability',
            'create_event_with_confirmation',
            'update_event_with_confirmation',
            'delete_event_with_confirmation',
            'rsvp_with_confirmation',
            'move_event_with_confirmation',
        ],
        error,
    }
}

export async function saveGoogleCalendarOAuthConfig(origin: string, input: GoogleOAuthConfigInput): Promise<GoogleCalendarIntegrationStatus> {
    saveGoogleOAuthClientConfig(origin, input, GOOGLE_CALENDAR_PROVIDER)
    return getGoogleCalendarIntegrationStatus(origin, false)
}

export function startGoogleCalendarOAuth(origin: string) {
    return startGoogleOAuth({
        origin,
        provider: GOOGLE_CALENDAR_PROVIDER,
        scopes: GOOGLE_CALENDAR_SCOPES,
    })
}

export async function completeGoogleCalendarOAuth(args: {
    origin: string
    state: string
    code: string
}): Promise<{ accountEmail: string | null }> {
    const config = getGoogleOAuthConfig(args.origin, GOOGLE_CALENDAR_PROVIDER)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }

    const token = await exchangeGoogleOAuthCode({
        origin: args.origin,
        provider: GOOGLE_CALENDAR_PROVIDER,
        state: args.state,
        code: args.code,
    })
    const existing = readCalendarToken()
    const refreshToken = token.refresh_token || existing?.refreshToken
    if (!token.access_token) throw new Error('Google did not return an access token.')
    if (!refreshToken) throw new Error('Google did not return a refresh token. Reconnect and approve offline access.')

    const grantedScopes = parseScopeList(token.scope)
    const missingScopes = missingGoogleScopes(grantedScopes, GOOGLE_CALENDAR_SCOPES)
    if (missingScopes.length > 0) {
        throw new Error(`Google Calendar consent is missing required scopes: ${missingScopes.join(', ')}`)
    }

    const profile = await fetchCalendarProfile(token.access_token)
    const now = Date.now()
    writeGoogleOAuthToken(GOOGLE_CALENDAR_TOKEN_PATH, {
        version: 1,
        provider: GOOGLE_CALENDAR_PROVIDER.provider,
        clientId: config.clientId,
        accountEmail: profile.accountEmail ?? undefined,
        accessToken: token.access_token,
        refreshToken,
        tokenType: token.token_type,
        scope: grantedScopes,
        scopesRequested: [...GOOGLE_CALENDAR_SCOPES],
        expiresAt: now + Math.max(0, token.expires_in ?? 3600) * 1000,
        obtainedAt: existing?.obtainedAt ?? now,
        updatedAt: now,
    })

    return { accountEmail: profile.accountEmail }
}

export async function disconnectGoogleCalendar(): Promise<GoogleCalendarIntegrationStatus> {
    const token = readCalendarToken()
    await revokeGoogleOAuthToken(token)
    clearGoogleOAuthToken(GOOGLE_CALENDAR_TOKEN_PATH)
    return getGoogleCalendarIntegrationStatus(DEFAULT_ORIGIN, false)
}

export async function googleCalendarListCalendars(options: GoogleCalendarListOptions = {}): Promise<{ calendars: GoogleCalendarInfo[] }> {
    const maxResults = clampInt(options.maxResults ?? MAX_CALENDAR_MAX_RESULTS, 1, MAX_CALENDAR_MAX_RESULTS)
    const params = new URLSearchParams()
    params.set('maxResults', String(Math.min(maxResults, 250)))
    if (options.minAccessRole) params.set('minAccessRole', options.minAccessRole)
    if (options.showHidden) params.set('showHidden', 'true')
    if (options.showDeleted) params.set('showDeleted', 'true')

    const calendars: GoogleCalendarInfo[] = []
    let pageToken: string | undefined
    do {
        if (pageToken) params.set('pageToken', pageToken)
        const result = await calendarApi<CalendarListResponse>(`/users/me/calendarList?${params.toString()}`)
        calendars.push(...(result.items ?? []).map(summarizeCalendar))
        pageToken = result.nextPageToken
    } while (pageToken && calendars.length < maxResults)

    return { calendars: calendars.slice(0, maxResults) }
}

export async function googleCalendarListEvents(options: GoogleCalendarEventListOptions = {}): Promise<{
    calendarId: string
    events: GoogleCalendarEventSummary[]
}> {
    const calendarId = cleanCalendarId(options.calendarId)
    const maxResults = clampInt(options.maxResults ?? DEFAULT_EVENT_MAX_RESULTS, 1, MAX_EVENT_MAX_RESULTS)
    const singleEvents = options.singleEvents ?? true
    const params = new URLSearchParams()
    params.set('maxResults', String(Math.min(maxResults, 250)))
    params.set('singleEvents', String(singleEvents))
    if (singleEvents) params.set('orderBy', options.orderBy ?? 'startTime')
    else if (options.orderBy) params.set('orderBy', options.orderBy)
    if (options.timeMin) params.set('timeMin', normalizeIsoDateTime(options.timeMin, 'time_min'))
    if (options.timeMax) params.set('timeMax', normalizeIsoDateTime(options.timeMax, 'time_max'))
    if (options.query) params.set('q', options.query.trim())
    if (options.showDeleted) params.set('showDeleted', 'true')
    if (options.timeZone) params.set('timeZone', options.timeZone.trim())
    for (const eventType of options.eventTypes ?? []) {
        const clean = eventType.trim()
        if (clean) params.append('eventTypes', clean)
    }

    const events: GoogleCalendarEventSummary[] = []
    let pageToken: string | undefined
    do {
        if (pageToken) params.set('pageToken', pageToken)
        const result = await calendarApi<CalendarEventsResponse>(
            `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
        )
        events.push(...(result.items ?? []).map(event => summarizeEvent(calendarId, event)))
        pageToken = result.nextPageToken
    } while (pageToken && events.length < maxResults)

    return { calendarId, events: events.slice(0, maxResults) }
}

export async function googleCalendarGetEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEventSummary> {
    const cleanCalendar = cleanCalendarId(calendarId)
    const cleanEvent = cleanRequired(eventId, 'event_id')
    const event = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}`
    )
    return summarizeEvent(cleanCalendar, event)
}

export async function googleCalendarSearchEvents(options: GoogleCalendarSearchOptions): Promise<{
    query: string
    calendars: Array<{ calendarId: string; summary: string; events: GoogleCalendarEventSummary[]; error?: string }>
}> {
    const query = cleanRequired(options.query, 'query')
    const calendarIds = options.calendarIds?.map(cleanCalendarId).filter(Boolean)
        ?? (await googleCalendarListCalendars({
            maxResults: 50,
            minAccessRole: options.includeReadOnlyCalendars === false ? 'writer' : 'reader',
        })).calendars.map(calendar => calendar.id)
    const maxResultsPerCalendar = clampInt(options.maxResultsPerCalendar ?? 10, 1, 50)
    const calendarSummaries = new Map((await googleCalendarListCalendars({ maxResults: 100 })).calendars.map(item => [item.id, item.summary]))

    const results = await Promise.all(calendarIds.map(async calendarId => {
        try {
            const events = await googleCalendarListEvents({
                calendarId,
                query,
                timeMin: options.timeMin,
                timeMax: options.timeMax,
                maxResults: maxResultsPerCalendar,
                singleEvents: true,
            })
            return {
                calendarId,
                summary: calendarSummaries.get(calendarId) ?? calendarId,
                events: events.events,
            }
        } catch (err) {
            return {
                calendarId,
                summary: calendarSummaries.get(calendarId) ?? calendarId,
                events: [],
                error: err instanceof Error ? err.message : 'Calendar search failed.',
            }
        }
    }))

    return { query, calendars: results }
}

export async function googleCalendarFreeBusy(options: GoogleCalendarFreeBusyOptions): Promise<FreeBusyResponse> {
    const calendarIds = cleanCalendarIds(options.calendarIds)
    const timeMin = normalizeIsoDateTime(options.timeMin, 'time_min')
    const timeMax = normalizeIsoDateTime(options.timeMax, 'time_max')
    assertRange(timeMin, timeMax)
    return calendarApi<FreeBusyResponse>('/freeBusy', {
        method: 'POST',
        body: JSON.stringify({
            timeMin,
            timeMax,
            timeZone: options.timeZone?.trim() || undefined,
            items: calendarIds.map(id => ({ id })),
        }),
    })
}

export async function googleCalendarFindAvailability(options: GoogleCalendarAvailabilityOptions): Promise<{
    calendarIds: string[]
    timeMin: string
    timeMax: string
    durationMinutes: number
    timeZone: string
    slots: Array<{ start: string; end: string }>
    busy: Array<{ calendarId: string; start: string; end: string }>
}> {
    const durationMinutes = clampInt(options.durationMinutes, 1, 24 * 60)
    const stepMinutes = clampInt(options.slotStepMinutes ?? 15, 5, 240)
    const maxResults = clampInt(options.maxResults ?? 10, 1, 100)
    const timeZone = options.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const freeBusy = await googleCalendarFreeBusy(options)
    const busy = Object.entries(freeBusy.calendars ?? {}).flatMap(([calendarId, item]) =>
        (item.busy ?? []).map(slot => ({ calendarId, start: slot.start, end: slot.end }))
    )
    const busyRanges = busy
        .map(slot => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }))
        .filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.end))
        .sort((a, b) => a.start - b.start)

    const startMs = Date.parse(normalizeIsoDateTime(options.timeMin, 'time_min'))
    const endMs = Date.parse(normalizeIsoDateTime(options.timeMax, 'time_max'))
    const durationMs = durationMinutes * 60_000
    const stepMs = stepMinutes * 60_000
    const workdayStart = parseClock(options.workdayStart)
    const workdayEnd = parseClock(options.workdayEnd)
    const days = new Set((options.daysOfWeek ?? []).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))
    const slots: Array<{ start: string; end: string }> = []
    let iterations = 0

    for (let cursor = startMs; cursor + durationMs <= endMs && iterations < MAX_AVAILABILITY_ITERATIONS; cursor += stepMs) {
        iterations += 1
        const slotEnd = cursor + durationMs
        if (days.size > 0 && !days.has(localWeekday(cursor, timeZone))) continue
        if (workdayStart && workdayEnd && !withinLocalClockWindow(cursor, slotEnd, timeZone, workdayStart, workdayEnd)) continue
        if (busyRanges.some(range => rangesOverlap(cursor, slotEnd, range.start, range.end))) continue
        slots.push({ start: new Date(cursor).toISOString(), end: new Date(slotEnd).toISOString() })
        if (slots.length >= maxResults) break
    }

    return {
        calendarIds: cleanCalendarIds(options.calendarIds),
        timeMin: new Date(startMs).toISOString(),
        timeMax: new Date(endMs).toISOString(),
        durationMinutes,
        timeZone,
        slots,
        busy,
    }
}

export async function googleCalendarCreateEvent(input: GoogleCalendarEventInput, options: GoogleCalendarEventWriteOptions = {}): Promise<GoogleCalendarEventSummary> {
    const calendarId = cleanCalendarId(input.calendarId)
    const resource = buildEventResource(input, false)
    const params = writeParams(options, input.createMeet)
    const created = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        {
            method: 'POST',
            body: JSON.stringify(resource),
        }
    )
    return summarizeEvent(calendarId, created)
}

export async function googleCalendarPatchEvent(
    calendarId: string,
    eventId: string,
    input: GoogleCalendarEventInput,
    options: GoogleCalendarEventWriteOptions = {}
): Promise<GoogleCalendarEventSummary> {
    const cleanCalendar = cleanCalendarId(calendarId)
    const cleanEvent = cleanRequired(eventId, 'event_id')
    const resource = buildEventResource(input, true)
    if (Object.keys(resource).length === 0) throw new Error('Provide at least one event field to update.')
    const params = writeParams(options, input.createMeet)
    const updated = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}?${params.toString()}`,
        {
            method: 'PATCH',
            body: JSON.stringify(resource),
        }
    )
    return summarizeEvent(cleanCalendar, updated)
}

export async function googleCalendarDeleteEvent(
    calendarId: string,
    eventId: string,
    options: GoogleCalendarEventWriteOptions = {}
): Promise<{ calendarId: string; eventId: string; deleted: true }> {
    const cleanCalendar = cleanCalendarId(calendarId)
    const cleanEvent = cleanRequired(eventId, 'event_id')
    const params = writeParams(options, false)
    await calendarApi<unknown>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}?${params.toString()}`,
        { method: 'DELETE' }
    )
    return { calendarId: cleanCalendar, eventId: cleanEvent, deleted: true }
}

export async function googleCalendarRespondToEvent(
    calendarId: string,
    eventId: string,
    responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction',
    options: GoogleCalendarEventWriteOptions = {}
): Promise<GoogleCalendarEventSummary> {
    const cleanCalendar = cleanCalendarId(calendarId)
    const cleanEvent = cleanRequired(eventId, 'event_id')
    const token = await getValidCalendarToken()
    const event = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}`
    )
    const selfEmail = token.accountEmail || inferAccountEmail(cleanCalendar)
    if (!selfEmail) throw new Error('Could not infer the connected Google Calendar account email for RSVP.')
    const attendees = event.attendees ?? []
    const idx = attendees.findIndex(attendee => attendee.self || attendee.email?.toLowerCase() === selfEmail.toLowerCase())
    if (idx < 0) throw new Error('This event does not include the connected account as an attendee.')
    const updatedAttendees = attendees.map((attendee, index) =>
        index === idx ? { ...attendee, responseStatus } : attendee
    )
    const params = writeParams(options, false)
    const updated = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}?${params.toString()}`,
        {
            method: 'PATCH',
            body: JSON.stringify({ attendees: updatedAttendees }),
        }
    )
    return summarizeEvent(cleanCalendar, updated)
}

export async function googleCalendarMoveEvent(
    calendarId: string,
    eventId: string,
    destinationCalendarId: string,
    options: GoogleCalendarEventWriteOptions = {}
): Promise<GoogleCalendarEventSummary> {
    const cleanCalendar = cleanCalendarId(calendarId)
    const cleanEvent = cleanRequired(eventId, 'event_id')
    const destination = cleanRequired(destinationCalendarId, 'destination_calendar_id')
    const params = writeParams(options, false)
    params.set('destination', destination)
    const moved = await calendarApi<CalendarEvent>(
        `/calendars/${encodeURIComponent(cleanCalendar)}/events/${encodeURIComponent(cleanEvent)}/move?${params.toString()}`,
        { method: 'POST' }
    )
    return summarizeEvent(destination, moved)
}

async function fetchCalendarProfile(accessToken: string): Promise<{ accountEmail: string | null }> {
    const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList?maxResults=50`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
        },
    })
    if (!response.ok) {
        throw new Error(`Could not read Google Calendar profile (${response.status}): ${await responseErrorText(response)}`)
    }
    const result = await response.json() as CalendarListResponse
    const primary = result.items?.find(item => item.primary) ?? result.items?.[0] ?? null
    return { accountEmail: inferAccountEmail(primary?.id ?? null) }
}

async function calendarApi<T>(pathAndQuery: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await getValidCalendarToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}${pathAndQuery}`, {
        ...init,
        headers,
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_CALENDAR_PROVIDER), GOOGLE_CALENDAR_TOKEN_PATH)
        return calendarApi<T>(pathAndQuery, init, false)
    }

    if (!response.ok) {
        throw new Error(`Google Calendar API failed (${response.status}): ${await responseErrorText(response)}`)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
}

async function getValidCalendarToken(): Promise<GoogleOAuthTokenRecord> {
    const token = readCalendarToken()
    if (!token) throw new Error('Google Calendar is not connected. Connect it from Settings > Auth.')
    if (token.expiresAt > Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS) return token
    if (!token.refreshToken) throw new Error('Google Calendar session expired. Reconnect Google Calendar from Settings > Auth.')
    return refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_CALENDAR_PROVIDER), GOOGLE_CALENDAR_TOKEN_PATH)
}

function readCalendarToken(): GoogleOAuthTokenRecord | null {
    return readGoogleOAuthToken(GOOGLE_CALENDAR_TOKEN_PATH, GOOGLE_CALENDAR_PROVIDER.provider)
}

function summarizeCalendar(item: CalendarListEntry): GoogleCalendarInfo {
    const accessRole = item.accessRole ?? 'reader'
    return {
        id: item.id,
        summary: item.summary ?? item.id,
        description: item.description ?? '',
        primary: item.primary === true,
        timeZone: item.timeZone ?? null,
        accessRole,
        selected: item.selected === true,
        hidden: item.hidden === true,
        backgroundColor: item.backgroundColor ?? null,
        foregroundColor: item.foregroundColor ?? null,
        canWriteEvents: canWriteEvents(accessRole),
        conferenceTypes: item.conferenceProperties?.allowedConferenceSolutionTypes ?? [],
    }
}

function summarizeEvent(calendarId: string, event: CalendarEvent): GoogleCalendarEventSummary {
    const start = event.start ?? {}
    const end = event.end ?? {}
    return {
        calendarId,
        id: event.id,
        status: event.status ?? '',
        htmlLink: event.htmlLink ?? '',
        summary: event.summary ?? '(No title)',
        description: event.description ?? '',
        location: event.location ?? '',
        start: eventDateValue(start),
        end: eventDateValue(end),
        allDay: Boolean(start.date || end.date),
        timeZone: start.timeZone ?? end.timeZone ?? null,
        created: event.created ?? null,
        updated: event.updated ?? null,
        creator: summarizePerson(event.creator),
        organizer: summarizePerson(event.organizer),
        attendees: (event.attendees ?? []).map(summarizeAttendee),
        recurrence: event.recurrence ?? [],
        recurringEventId: event.recurringEventId ?? null,
        originalStartTime: event.originalStartTime ? eventDateValue(event.originalStartTime) : null,
        transparency: event.transparency ?? null,
        visibility: event.visibility ?? null,
        eventType: event.eventType ?? null,
        hangoutLink: event.hangoutLink ?? null,
        conference: event.conferenceData ? {
            conferenceId: event.conferenceData.conferenceId ?? '',
            entryPoints: (event.conferenceData.entryPoints ?? []).map(entry => ({
                type: entry.entryPointType ?? '',
                uri: entry.uri ?? '',
                label: entry.label ?? '',
            })),
        } : null,
        reminders: event.reminders ?? null,
    }
}

function summarizePerson(person: CalendarEventPerson | undefined): CalendarPerson | null {
    if (!person?.email && !person?.displayName) return null
    return {
        email: person.email ?? '',
        displayName: person.displayName ?? '',
        self: person.self === true,
    }
}

function summarizeAttendee(attendee: CalendarEventAttendee): CalendarAttendeeSummary {
    return {
        email: attendee.email ?? '',
        displayName: attendee.displayName ?? '',
        self: attendee.self === true,
        responseStatus: attendee.responseStatus ?? '',
        optional: attendee.optional === true,
        organizer: attendee.organizer === true,
        resource: attendee.resource === true,
    }
}

function buildEventResource(input: GoogleCalendarEventInput, patch: boolean): Record<string, unknown> {
    const resource: Record<string, unknown> = {}
    const summary = cleanOptional(input.summary)
    if (summary) resource.summary = summary
    else if (!patch) throw new Error('Event summary is required.')
    assignOptional(resource, 'description', input.description)
    assignOptional(resource, 'location', input.location)
    assignOptional(resource, 'transparency', input.transparency)
    assignOptional(resource, 'visibility', input.visibility)
    assignOptional(resource, 'colorId', input.colorId)
    if (typeof input.guestsCanModify === 'boolean') resource.guestsCanModify = input.guestsCanModify
    if (typeof input.guestsCanInviteOthers === 'boolean') resource.guestsCanInviteOthers = input.guestsCanInviteOthers
    if (typeof input.guestsCanSeeOtherGuests === 'boolean') resource.guestsCanSeeOtherGuests = input.guestsCanSeeOtherGuests
    if (input.recurrence) {
        const recurrence = input.recurrence.map(item => item.trim()).filter(Boolean)
        if (recurrence.length > 0) resource.recurrence = recurrence
    }
    const attendees = buildAttendees(input.attendees, false).concat(buildAttendees(input.optionalAttendees, true))
    if (attendees.length > 0) resource.attendees = attendees
    if (input.reminders) resource.reminders = normalizeReminders(input.reminders)
    const dates = buildEventDates(input, patch)
    if (dates.start) resource.start = dates.start
    if (dates.end) resource.end = dates.end
    if (input.createMeet) {
        resource.conferenceData = {
            createRequest: {
                requestId: randomBytes(12).toString('hex'),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
        }
    }
    return resource
}

function buildEventDates(input: GoogleCalendarEventInput, patch: boolean): { start?: CalendarEventDate; end?: CalendarEventDate } {
    const startDate = cleanOptional(input.startDate)
    const endDate = cleanOptional(input.endDate)
    const startDateTime = cleanOptional(input.startDateTime)
    const endDateTime = cleanOptional(input.endDateTime)
    const timeZone = cleanOptional(input.timeZone)
    const anyDate = Boolean(startDate || endDate)
    const anyDateTime = Boolean(startDateTime || endDateTime)
    if (anyDate && anyDateTime) throw new Error('Use either all-day date fields or timed dateTime fields, not both.')
    if (!anyDate && !anyDateTime) {
        if (patch) return {}
        throw new Error('Event start and end are required.')
    }
    if (anyDate) {
        if (!startDate || !endDate) throw new Error('All-day events require start_date and end_date. Google Calendar end_date is exclusive.')
        assertDateOnly(startDate, 'start_date')
        assertDateOnly(endDate, 'end_date')
        return { start: { date: startDate }, end: { date: endDate } }
    }
    if (!startDateTime || !endDateTime) throw new Error('Timed events require start_datetime and end_datetime.')
    const start = normalizeIsoDateTime(startDateTime, 'start_datetime')
    const end = normalizeIsoDateTime(endDateTime, 'end_datetime')
    assertRange(start, end)
    return {
        start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
        end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
    }
}

function normalizeReminders(input: GoogleCalendarReminderInput): GoogleCalendarReminderInput {
    const useDefault = input.useDefault === true
    const overrides = (input.overrides ?? []).map(item => ({
        method: item.method === 'email' ? 'email' as const : 'popup' as const,
        minutes: clampInt(item.minutes, 0, 40320),
    }))
    return {
        useDefault,
        ...(useDefault ? {} : { overrides }),
    }
}

function buildAttendees(values: string[] | undefined, optional: boolean): Array<{ email: string; optional?: boolean }> {
    return (values ?? [])
        .map(value => value.trim())
        .filter(Boolean)
        .map(email => optional ? { email, optional: true } : { email })
}

function writeParams(options: GoogleCalendarEventWriteOptions, conferenceData = false): URLSearchParams {
    const params = new URLSearchParams()
    params.set('sendUpdates', options.sendUpdates ?? 'all')
    if (conferenceData) params.set('conferenceDataVersion', '1')
    return params
}

function eventDateValue(date: CalendarEventDate): string {
    return date.dateTime ?? date.date ?? ''
}

function cleanCalendarId(value?: string): string {
    return cleanOptional(value) || 'primary'
}

function cleanCalendarIds(values: string[]): string[] {
    const out = values.map(cleanCalendarId).filter(Boolean)
    if (out.length === 0) throw new Error('At least one calendar_id is required.')
    return [...new Set(out)]
}

function cleanRequired(value: string | undefined, name: string): string {
    const clean = cleanOptional(value)
    if (!clean) throw new Error(`Missing required parameter: ${name}`)
    return clean
}

function cleanOptional(value: string | undefined): string {
    return (value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function assignOptional(target: Record<string, unknown>, key: string, value: string | undefined): void {
    const clean = cleanOptional(value)
    if (clean) target[key] = clean
}

function normalizeIsoDateTime(value: string, name: string): string {
    const clean = cleanRequired(value, name)
    const ms = Date.parse(clean)
    if (!Number.isFinite(ms)) throw new Error(`${name} must be an ISO date-time with timezone or offset.`)
    return new Date(ms).toISOString()
}

function assertDateOnly(value: string, name: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD.`)
}

function assertRange(startIso: string, endIso: string): void {
    if (Date.parse(endIso) <= Date.parse(startIso)) throw new Error('End time must be after start time.')
}

function canWriteEvents(accessRole: string): boolean {
    return ACCESS_ROLE_ORDER.indexOf(accessRole as typeof ACCESS_ROLE_ORDER[number]) >= ACCESS_ROLE_ORDER.indexOf('writer')
}

function inferAccountEmail(value: string | null): string | null {
    if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return null
    return value
}

function clampInt(value: number, min: number, max: number): number {
    const parsed = Number.isFinite(value) ? Math.floor(value) : min
    return Math.min(max, Math.max(min, parsed))
}

function parseClock(value: string | undefined): { hour: number; minute: number } | null {
    if (!value) return null
    const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/)
    if (!match) throw new Error('Clock values must be HH:mm, for example 09:00.')
    return { hour: Number(match[1]), minute: Number(match[2]) }
}

function withinLocalClockWindow(
    startMs: number,
    endMs: number,
    timeZone: string,
    workdayStart: { hour: number; minute: number },
    workdayEnd: { hour: number; minute: number }
): boolean {
    const start = localMinutes(startMs, timeZone)
    const end = localMinutes(endMs, timeZone)
    const min = workdayStart.hour * 60 + workdayStart.minute
    const max = workdayEnd.hour * 60 + workdayEnd.minute
    return start >= min && end <= max
}

function localMinutes(ms: number, timeZone: string): number {
    const parts = dateParts(ms, timeZone)
    return parts.hour * 60 + parts.minute
}

function localWeekday(ms: number, timeZone: string): number {
    return dateParts(ms, timeZone).weekday
}

function dateParts(ms: number, timeZone: string): { hour: number; minute: number; weekday: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
    const parts = formatter.formatToParts(new Date(ms))
    const value = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    const weekdayMap: Record<string, number> = {
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 7,
    }
    return {
        hour: Number(value('hour')) % 24,
        minute: Number(value('minute')),
        weekday: weekdayMap[value('weekday')] ?? 1,
    }
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
    return aStart < bEnd && bStart < aEnd
}
