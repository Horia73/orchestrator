import type { ToolDef, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    type GoogleCalendarEventInput,
    type GoogleCalendarReminderInput,
    getGoogleCalendarIntegrationStatus,
    googleCalendarCreateEvent,
    googleCalendarDeleteEvent,
    googleCalendarFindAvailability,
    googleCalendarFreeBusy,
    googleCalendarGetEvent,
    googleCalendarListCalendars,
    googleCalendarListEvents,
    googleCalendarMoveEvent,
    googleCalendarPatchEvent,
    googleCalendarRespondToEvent,
    googleCalendarSearchEvents,
    saveGoogleCalendarOAuthConfig,
    startGoogleCalendarOAuth,
} from '@/lib/integrations/google-calendar'
import { booleanArg, clamp, numberArg, stringArg } from './helpers'

const DEFAULT_ORIGIN = 'http://localhost:3000'

export const googleCalendarStatusTool: ToolDef = {
    id: 'GoogleCalendarStatus',
    name: 'GoogleCalendarStatus',
    description: 'Checks Google Calendar integration status, connected account, granted scopes, primary calendar, and writable-calendar count.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'google-calendar', 'setup'],
}

export const googleCalendarConfigureTool: ToolDef = {
    id: 'GoogleCalendarConfigure',
    name: 'GoogleCalendarConfigure',
    description: [
        'Saves reusable Google OAuth client config for Google Calendar and future Workspace integrations.',
        'Use when the user provides Google OAuth client JSON, env lines, client ID, or client secret.',
        'Never echo client secrets back to the user.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            client_id: { type: 'string', description: 'Google OAuth client ID.' },
            client_secret: { type: 'string', description: 'Google OAuth client secret. Treat as secret.' },
            redirect_uri: { type: 'string', description: 'Optional redirect URI. Defaults to the app Google OAuth callback.' },
            raw_env: { type: 'string', description: 'Pasted env lines or Google OAuth client JSON.' },
        },
    },
    tags: ['read', 'google-calendar', 'setup'],
}

export const googleCalendarStartOAuthTool: ToolDef = {
    id: 'GoogleCalendarStartOAuth',
    name: 'GoogleCalendarStartOAuth',
    description: 'Starts Google Calendar OAuth and returns the consent URL the user must open. Do not claim the connection succeeded until status confirms it.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'google-calendar', 'setup', 'external_action'],
}

export const googleCalendarListCalendarsTool: ToolDef = {
    id: 'GoogleCalendarListCalendars',
    name: 'GoogleCalendarListCalendars',
    description: 'Lists Google calendars visible to the connected account, including access role and whether events can be written.',
    input_schema: {
        type: 'object',
        properties: {
            max_results: { type: 'integer', description: 'Maximum calendars to return. Defaults to 250 and is capped at 250.' },
            min_access_role: {
                type: 'string',
                enum: ['freeBusyReader', 'reader', 'writer', 'owner'],
                description: 'Optional minimum access role.',
            },
            show_hidden: { type: 'boolean', description: 'Include hidden calendars.' },
            show_deleted: { type: 'boolean', description: 'Include deleted calendar-list entries.' },
        },
    },
    tags: ['read', 'google-calendar', 'calendar'],
}

export const googleCalendarListEventsTool: ToolDef = {
    id: 'GoogleCalendarListEvents',
    name: 'GoogleCalendarListEvents',
    description: 'Lists Google Calendar events from one calendar. Use explicit ISO time_min/time_max with timezone for date-bounded reads.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema(),
            time_min: { type: 'string', description: 'Inclusive lower bound as ISO date-time with timezone/offset.' },
            time_max: { type: 'string', description: 'Exclusive upper bound as ISO date-time with timezone/offset.' },
            query: { type: 'string', description: 'Optional full-text event search.' },
            max_results: { type: 'integer', description: 'Defaults to 50 and is capped at 250.' },
            single_events: { type: 'boolean', description: 'Expand recurring events into instances. Defaults to true.' },
            order_by: { type: 'string', enum: ['startTime', 'updated'], description: 'Defaults to startTime when single_events is true.' },
            show_deleted: { type: 'boolean', description: 'Include cancelled/deleted events.' },
            time_zone: { type: 'string', description: 'IANA timezone used by Google for returned event times.' },
            event_types: { type: 'array', items: { type: 'string' }, description: 'Optional Google eventTypes filter.' },
        },
    },
    tags: ['read', 'google-calendar', 'event'],
}

export const googleCalendarGetEventTool: ToolDef = {
    id: 'GoogleCalendarGetEvent',
    name: 'GoogleCalendarGetEvent',
    description: 'Gets one Google Calendar event by calendar_id and event_id.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema(),
            event_id: { type: 'string', description: 'Google Calendar event ID.' },
        },
        required: ['event_id'],
    },
    tags: ['read', 'google-calendar', 'event'],
}

export const googleCalendarSearchEventsTool: ToolDef = {
    id: 'GoogleCalendarSearchEvents',
    name: 'GoogleCalendarSearchEvents',
    description: 'Searches events by text across selected calendars or visible calendars. Use bounded time_min/time_max when possible.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query.' },
            calendar_ids: { type: 'array', items: { type: 'string' }, description: 'Optional calendars to search. Defaults to visible calendars.' },
            time_min: { type: 'string', description: 'Optional inclusive lower bound as ISO date-time.' },
            time_max: { type: 'string', description: 'Optional exclusive upper bound as ISO date-time.' },
            max_results_per_calendar: { type: 'integer', description: 'Defaults to 10 and is capped at 50.' },
            include_read_only_calendars: { type: 'boolean', description: 'Defaults to true.' },
        },
        required: ['query'],
    },
    tags: ['read', 'google-calendar', 'event'],
}

export const googleCalendarFreeBusyTool: ToolDef = {
    id: 'GoogleCalendarFreeBusy',
    name: 'GoogleCalendarFreeBusy',
    description: 'Reads free/busy blocks for one or more calendars in a bounded time window.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_ids: { type: 'array', items: { type: 'string' }, description: 'Calendar IDs. Use primary for the primary calendar.' },
            time_min: { type: 'string', description: 'Inclusive lower bound as ISO date-time with timezone/offset.' },
            time_max: { type: 'string', description: 'Exclusive upper bound as ISO date-time with timezone/offset.' },
            time_zone: { type: 'string', description: 'Optional IANA timezone.' },
        },
        required: ['calendar_ids', 'time_min', 'time_max'],
    },
    tags: ['read', 'google-calendar', 'availability'],
}

export const googleCalendarFindAvailabilityTool: ToolDef = {
    id: 'GoogleCalendarFindAvailability',
    name: 'GoogleCalendarFindAvailability',
    description: 'Finds open slots by subtracting Google Calendar free/busy blocks from a bounded window.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_ids: { type: 'array', items: { type: 'string' }, description: 'Calendar IDs to consider busy.' },
            time_min: { type: 'string', description: 'Inclusive search-window start as ISO date-time with timezone/offset.' },
            time_max: { type: 'string', description: 'Exclusive search-window end as ISO date-time with timezone/offset.' },
            duration_minutes: { type: 'integer', description: 'Desired slot length in minutes.' },
            slot_step_minutes: { type: 'integer', description: 'Search step. Defaults to 15 minutes.' },
            time_zone: { type: 'string', description: 'IANA timezone for workday/day filters.' },
            workday_start: { type: 'string', description: 'Optional local HH:mm lower bound, e.g. 09:00.' },
            workday_end: { type: 'string', description: 'Optional local HH:mm upper bound, e.g. 17:30.' },
            days_of_week: { type: 'array', items: { type: 'integer' }, description: 'Optional ISO weekdays, 1=Monday through 7=Sunday.' },
            max_results: { type: 'integer', description: 'Defaults to 10 and is capped at 100.' },
        },
        required: ['calendar_ids', 'time_min', 'time_max', 'duration_minutes'],
    },
    tags: ['read', 'google-calendar', 'availability'],
}

export const googleCalendarCreateEventTool: ToolDef = {
    id: 'GoogleCalendarCreateEvent',
    name: 'GoogleCalendarCreateEvent',
    description: 'Creates a Google Calendar event. Only use after explicit user approval of calendar, title, date/time/timezone, attendees, Meet link, recurrence, and notification behavior.',
    input_schema: eventWriteSchema(['summary', 'confirmed_by_user']),
    tags: ['write', 'google-calendar', 'event', 'external_action'],
}

export const googleCalendarUpdateEventTool: ToolDef = {
    id: 'GoogleCalendarUpdateEvent',
    name: 'GoogleCalendarUpdateEvent',
    description: 'Updates a Google Calendar event. Only use after explicit user approval of the exact event and fields being changed. For recurring events, confirm whether the event_id targets one instance or the series.',
    input_schema: eventWriteSchema(['event_id', 'confirmed_by_user']),
    tags: ['write', 'google-calendar', 'event', 'external_action'],
}

export const googleCalendarDeleteEventTool: ToolDef = {
    id: 'GoogleCalendarDeleteEvent',
    name: 'GoogleCalendarDeleteEvent',
    description: 'Deletes a Google Calendar event. Only use after explicit user approval of the exact calendar, event, and notification behavior.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema(),
            event_id: { type: 'string', description: 'Event ID to delete.' },
            send_updates: sendUpdatesSchema(),
            confirmed_by_user: confirmationSchema('Must be true only after explicit approval to delete this event.'),
        },
        required: ['event_id', 'confirmed_by_user'],
    },
    tags: ['write', 'google-calendar', 'event', 'destructive', 'external_action'],
}

export const googleCalendarRespondToEventTool: ToolDef = {
    id: 'GoogleCalendarRespondToEvent',
    name: 'GoogleCalendarRespondToEvent',
    description: 'RSVPs to an event as the connected Google account. Only use after explicit user approval.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema(),
            event_id: { type: 'string', description: 'Event ID.' },
            response_status: {
                type: 'string',
                enum: ['accepted', 'declined', 'tentative', 'needsAction'],
                description: 'RSVP response.',
            },
            send_updates: sendUpdatesSchema(),
            confirmed_by_user: confirmationSchema('Must be true only after explicit approval to RSVP.'),
        },
        required: ['event_id', 'response_status', 'confirmed_by_user'],
    },
    tags: ['write', 'google-calendar', 'event', 'external_action'],
}

export const googleCalendarMoveEventTool: ToolDef = {
    id: 'GoogleCalendarMoveEvent',
    name: 'GoogleCalendarMoveEvent',
    description: 'Moves an event to another calendar. Only use after explicit user approval of source, destination, event, and notification behavior.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema('Source calendar ID. Defaults to primary.'),
            event_id: { type: 'string', description: 'Event ID to move.' },
            destination_calendar_id: { type: 'string', description: 'Destination calendar ID.' },
            send_updates: sendUpdatesSchema(),
            confirmed_by_user: confirmationSchema('Must be true only after explicit approval to move this event.'),
        },
        required: ['event_id', 'destination_calendar_id', 'confirmed_by_user'],
    },
    tags: ['write', 'google-calendar', 'event', 'external_action'],
}

export const googleCalendarTools: ToolDef[] = [
    googleCalendarStatusTool,
    googleCalendarConfigureTool,
    googleCalendarStartOAuthTool,
    googleCalendarListCalendarsTool,
    googleCalendarListEventsTool,
    googleCalendarGetEventTool,
    googleCalendarSearchEventsTool,
    googleCalendarFreeBusyTool,
    googleCalendarFindAvailabilityTool,
    googleCalendarCreateEventTool,
    googleCalendarUpdateEventTool,
    googleCalendarDeleteEventTool,
    googleCalendarRespondToEventTool,
    googleCalendarMoveEventTool,
]

export async function executeGoogleCalendarStatus(): Promise<ToolResult> {
    return { success: true, data: await getGoogleCalendarIntegrationStatus(DEFAULT_ORIGIN, true) }
}

export async function executeGoogleCalendarConfigure(args: Record<string, unknown>): Promise<ToolResult> {
    const data = await saveGoogleCalendarOAuthConfig(DEFAULT_ORIGIN, {
        clientId: stringArg(args, ['client_id', 'clientId']),
        clientSecret: stringArg(args, ['client_secret', 'clientSecret']),
        redirectUri: stringArg(args, ['redirect_uri', 'redirectUri']),
        rawEnv: stringArg(args, ['raw_env', 'rawEnv']),
    })
    return { success: true, data }
}

export async function executeGoogleCalendarStartOAuth(): Promise<ToolResult> {
    return { success: true, data: startGoogleCalendarOAuth(DEFAULT_ORIGIN) }
}

export async function executeGoogleCalendarListCalendars(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleCalendarListCalendars({
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 250)), 1, 250),
            minAccessRole: enumArg(args, ['min_access_role', 'minAccessRole'], ['freeBusyReader', 'reader', 'writer', 'owner']),
            showHidden: booleanArg(args, ['show_hidden', 'showHidden']),
            showDeleted: booleanArg(args, ['show_deleted', 'showDeleted']),
        }),
    }
}

export async function executeGoogleCalendarListEvents(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleCalendarListEvents({
            calendarId: stringArg(args, ['calendar_id', 'calendarId']),
            timeMin: stringArg(args, ['time_min', 'timeMin']),
            timeMax: stringArg(args, ['time_max', 'timeMax']),
            query: stringArg(args, ['query', 'q']),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 50)), 1, 250),
            singleEvents: booleanArg(args, ['single_events', 'singleEvents'], true),
            orderBy: enumArg(args, ['order_by', 'orderBy'], ['startTime', 'updated']),
            showDeleted: booleanArg(args, ['show_deleted', 'showDeleted']),
            timeZone: stringArg(args, ['time_zone', 'timeZone']),
            eventTypes: stringArrayArg(args, ['event_types', 'eventTypes']),
        }),
    }
}

export async function executeGoogleCalendarGetEvent(args: Record<string, unknown>): Promise<ToolResult> {
    const eventId = stringArg(args, ['event_id', 'eventId'])
    if (!eventId) return { success: false, error: 'Missing required parameter: event_id' }
    return {
        success: true,
        data: await googleCalendarGetEvent(stringArg(args, ['calendar_id', 'calendarId']) || 'primary', eventId),
    }
}

export async function executeGoogleCalendarSearchEvents(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return { success: false, error: 'Missing required parameter: query' }
    return {
        success: true,
        data: await googleCalendarSearchEvents({
            query,
            calendarIds: stringArrayArg(args, ['calendar_ids', 'calendarIds']),
            timeMin: stringArg(args, ['time_min', 'timeMin']),
            timeMax: stringArg(args, ['time_max', 'timeMax']),
            maxResultsPerCalendar: clamp(Math.floor(numberArg(args, ['max_results_per_calendar', 'maxResultsPerCalendar'], 10)), 1, 50),
            includeReadOnlyCalendars: booleanArg(args, ['include_read_only_calendars', 'includeReadOnlyCalendars'], true),
        }),
    }
}

export async function executeGoogleCalendarFreeBusy(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseWindowArgs(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleCalendarFreeBusy(parsed.options) }
}

export async function executeGoogleCalendarFindAvailability(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseWindowArgs(args)
    if (!parsed.ok) return parsed.error
    const durationMinutes = Math.floor(numberArg(args, ['duration_minutes', 'durationMinutes'], 0))
    if (durationMinutes <= 0) return { success: false, error: 'Missing required parameter: duration_minutes' }
    return {
        success: true,
        data: await googleCalendarFindAvailability({
            ...parsed.options,
            durationMinutes,
            slotStepMinutes: Math.floor(numberArg(args, ['slot_step_minutes', 'slotStepMinutes'], 15)),
            workdayStart: stringArg(args, ['workday_start', 'workdayStart']),
            workdayEnd: stringArg(args, ['workday_end', 'workdayEnd']),
            daysOfWeek: numberArrayArg(args, ['days_of_week', 'daysOfWeek']),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 10)), 1, 100),
        }),
    }
}

export async function executeGoogleCalendarCreateEvent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true before creating a Google Calendar event.' }
    }
    const input = parseEventInput(args)
    return {
        success: true,
        data: await googleCalendarCreateEvent(input, { sendUpdates: sendUpdatesArg(args, input) }),
    }
}

export async function executeGoogleCalendarUpdateEvent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true before updating a Google Calendar event.' }
    }
    const eventId = stringArg(args, ['event_id', 'eventId'])
    if (!eventId) return { success: false, error: 'Missing required parameter: event_id' }
    const input = parseEventInput(args)
    return {
        success: true,
        data: await googleCalendarPatchEvent(
            stringArg(args, ['calendar_id', 'calendarId']) || 'primary',
            eventId,
            input,
            { sendUpdates: sendUpdatesArg(args, input) }
        ),
    }
}

export async function executeGoogleCalendarDeleteEvent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true before deleting a Google Calendar event.' }
    }
    const eventId = stringArg(args, ['event_id', 'eventId'])
    if (!eventId) return { success: false, error: 'Missing required parameter: event_id' }
    return {
        success: true,
        data: await googleCalendarDeleteEvent(
            stringArg(args, ['calendar_id', 'calendarId']) || 'primary',
            eventId,
            { sendUpdates: sendUpdatesArg(args) }
        ),
    }
}

export async function executeGoogleCalendarRespondToEvent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true before RSVPing to a Google Calendar event.' }
    }
    const eventId = stringArg(args, ['event_id', 'eventId'])
    if (!eventId) return { success: false, error: 'Missing required parameter: event_id' }
    const responseStatus = enumArg(args, ['response_status', 'responseStatus'], ['accepted', 'declined', 'tentative', 'needsAction'])
    if (!responseStatus) return { success: false, error: 'response_status must be accepted, declined, tentative, or needsAction.' }
    return {
        success: true,
        data: await googleCalendarRespondToEvent(
            stringArg(args, ['calendar_id', 'calendarId']) || 'primary',
            eventId,
            responseStatus,
            { sendUpdates: sendUpdatesArg(args) }
        ),
    }
}

export async function executeGoogleCalendarMoveEvent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return { success: false, error: 'confirmed_by_user must be true before moving a Google Calendar event.' }
    }
    const eventId = stringArg(args, ['event_id', 'eventId'])
    const destinationCalendarId = stringArg(args, ['destination_calendar_id', 'destinationCalendarId'])
    if (!eventId) return { success: false, error: 'Missing required parameter: event_id' }
    if (!destinationCalendarId) return { success: false, error: 'Missing required parameter: destination_calendar_id' }
    return {
        success: true,
        data: await googleCalendarMoveEvent(
            stringArg(args, ['calendar_id', 'calendarId']) || 'primary',
            eventId,
            destinationCalendarId,
            { sendUpdates: sendUpdatesArg(args) }
        ),
    }
}

function parseWindowArgs(args: Record<string, unknown>):
    | { ok: true; options: { calendarIds: string[]; timeMin: string; timeMax: string; timeZone?: string } }
    | { ok: false; error: ToolResult } {
    const calendarIds = stringArrayArg(args, ['calendar_ids', 'calendarIds'])
    const timeMin = stringArg(args, ['time_min', 'timeMin'])
    const timeMax = stringArg(args, ['time_max', 'timeMax'])
    if (calendarIds.length === 0) return { ok: false, error: { success: false, error: 'Missing required parameter: calendar_ids' } }
    if (!timeMin) return { ok: false, error: { success: false, error: 'Missing required parameter: time_min' } }
    if (!timeMax) return { ok: false, error: { success: false, error: 'Missing required parameter: time_max' } }
    return {
        ok: true,
        options: {
            calendarIds,
            timeMin,
            timeMax,
            timeZone: stringArg(args, ['time_zone', 'timeZone']) || undefined,
        },
    }
}

function parseEventInput(args: Record<string, unknown>): GoogleCalendarEventInput {
    const event = objectArg(args, ['event'])
    const source = event ?? args
    return {
        calendarId: stringArg(source, ['calendar_id', 'calendarId']) || stringArg(args, ['calendar_id', 'calendarId']),
        summary: stringArg(source, ['summary', 'title']),
        description: stringArg(source, ['description', 'notes']),
        location: stringArg(source, ['location']),
        startDate: stringArg(source, ['start_date', 'startDate']),
        endDate: stringArg(source, ['end_date', 'endDate']),
        startDateTime: stringArg(source, ['start_datetime', 'startDateTime']),
        endDateTime: stringArg(source, ['end_datetime', 'endDateTime']),
        timeZone: stringArg(source, ['time_zone', 'timeZone']),
        attendees: stringArrayArg(source, ['attendees']),
        optionalAttendees: stringArrayArg(source, ['optional_attendees', 'optionalAttendees']),
        recurrence: stringArrayArg(source, ['recurrence']),
        transparency: enumArg(source, ['transparency'], ['opaque', 'transparent']),
        visibility: enumArg(source, ['visibility'], ['default', 'public', 'private', 'confidential']),
        colorId: stringArg(source, ['color_id', 'colorId']),
        reminders: reminderArg(source),
        createMeet: booleanArg(source, ['create_meet', 'createMeet']),
        guestsCanModify: optionalBooleanArg(source, ['guests_can_modify', 'guestsCanModify']),
        guestsCanInviteOthers: optionalBooleanArg(source, ['guests_can_invite_others', 'guestsCanInviteOthers']),
        guestsCanSeeOtherGuests: optionalBooleanArg(source, ['guests_can_see_other_guests', 'guestsCanSeeOtherGuests']),
    }
}

function stringArrayArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function numberArrayArg(args: Record<string, unknown>, keys: string[]): number[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) {
            return value.map(item => typeof item === 'number' ? item : Number(item)).filter(Number.isFinite)
        }
        if (typeof value === 'string') {
            return value.split(',').map(item => Number(item.trim())).filter(Number.isFinite)
        }
    }
    return []
}

function objectArg(args: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
    for (const key of keys) {
        const value = args[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    }
    return null
}

function reminderArg(args: Record<string, unknown>): GoogleCalendarReminderInput | undefined {
    const raw = objectArg(args, ['reminders'])
    if (!raw) return undefined
    const overridesRaw = raw.overrides
    const overrides = Array.isArray(overridesRaw)
        ? overridesRaw
            .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
            .map(item => ({
                method: enumArg(item, ['method'], ['email', 'popup']) ?? 'popup',
                minutes: Math.max(0, Math.floor(numberArg(item, ['minutes'], 10))),
            }))
        : undefined
    return {
        useDefault: optionalBooleanArg(raw, ['useDefault', 'use_default']),
        overrides,
    }
}

function optionalBooleanArg(args: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true
            if (value.toLowerCase() === 'false') return false
        }
    }
    return undefined
}

function enumArg<T extends string>(args: Record<string, unknown>, keys: string[], allowed: readonly T[]): T | undefined {
    const value = stringArg(args, keys)
    if (!value) return undefined
    return allowed.includes(value as T) ? value as T : undefined
}

function sendUpdatesArg(args: Record<string, unknown>, input?: GoogleCalendarEventInput): 'all' | 'externalOnly' | 'none' {
    const explicit = enumArg(args, ['send_updates', 'sendUpdates'], ['all', 'externalOnly', 'none'])
    if (explicit) return explicit
    return (input?.attendees?.length || input?.optionalAttendees?.length) ? 'all' : 'none'
}

function calendarIdSchema(description = 'Calendar ID. Defaults to primary.'): ToolParameter {
    return { type: 'string', description }
}

function sendUpdatesSchema(): ToolParameter {
    return {
        type: 'string',
        enum: ['all', 'externalOnly', 'none'],
        description: 'Whether Google should send event update notifications. Defaults to all when attendees are present, otherwise none.',
    }
}

function confirmationSchema(description: string): ToolParameter {
    return { type: 'boolean', description }
}

function eventWriteSchema(required: string[]): ToolParameter {
    return {
        type: 'object',
        properties: {
            calendar_id: calendarIdSchema(),
            event_id: { type: 'string', description: 'Required for updates.' },
            summary: { type: 'string', description: 'Event title.' },
            description: { type: 'string', description: 'Event description or notes.' },
            location: { type: 'string', description: 'Event location.' },
            start_datetime: { type: 'string', description: 'Timed start as ISO date-time with timezone/offset.' },
            end_datetime: { type: 'string', description: 'Timed end as ISO date-time with timezone/offset.' },
            start_date: { type: 'string', description: 'All-day start date as YYYY-MM-DD.' },
            end_date: { type: 'string', description: 'All-day exclusive end date as YYYY-MM-DD.' },
            time_zone: { type: 'string', description: 'IANA timezone, e.g. Europe/Bucharest.' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'Required attendee email addresses.' },
            optional_attendees: { type: 'array', items: { type: 'string' }, description: 'Optional attendee email addresses.' },
            recurrence: { type: 'array', items: { type: 'string' }, description: 'RFC5545 recurrence lines, e.g. RRULE:FREQ=WEEKLY;COUNT=4.' },
            create_meet: { type: 'boolean', description: 'Create a Google Meet conference link.' },
            reminders: {
                type: 'object',
                description: 'Reminder settings: { useDefault: boolean, overrides: [{ method: email|popup, minutes: number }] }.',
            },
            transparency: { type: 'string', enum: ['opaque', 'transparent'], description: 'opaque means busy; transparent means free.' },
            visibility: { type: 'string', enum: ['default', 'public', 'private', 'confidential'] },
            color_id: { type: 'string', description: 'Optional Google Calendar event color ID.' },
            guests_can_modify: { type: 'boolean' },
            guests_can_invite_others: { type: 'boolean' },
            guests_can_see_other_guests: { type: 'boolean' },
            send_updates: sendUpdatesSchema(),
            confirmed_by_user: confirmationSchema('Must be true only after explicit approval for this calendar write.'),
            event: {
                type: 'object',
                description: 'Optional nested event object using the same field names.',
            },
        },
        required,
    }
}
