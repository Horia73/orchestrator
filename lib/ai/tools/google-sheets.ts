import type { ToolDef, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    googleSheetsAppendValues,
    googleSheetsBatchGetValues,
    googleSheetsBatchUpdate,
    googleSheetsClearValues,
    googleSheetsCreateSpreadsheet,
    googleSheetsGetSpreadsheet,
    googleSheetsGetValues,
    googleSheetsUpdateValues,
} from '@/lib/integrations/google-sheets'
import { booleanArg, stringArg } from './helpers'

export const googleSheetsTools: ToolDef[] = [
    {
        id: 'GoogleSheetsCreateSpreadsheet',
        name: 'GoogleSheetsCreateSpreadsheet',
        description: 'Creates a native Google Sheets spreadsheet. Use after confirming title, sheet tabs, and purpose.',
        input_schema: writeSchema({
            title: { type: 'string', description: 'Spreadsheet title.' },
            sheets: { type: 'array', items: { type: 'string' }, description: 'Optional initial sheet tab names.' },
        }, ['title', 'confirmed_by_user']),
        tags: ['write', 'google-sheets', 'spreadsheet', 'external_action'],
    },
    {
        id: 'GoogleSheetsGetSpreadsheet',
        name: 'GoogleSheetsGetSpreadsheet',
        description: 'Reads spreadsheet metadata: title, locale, timezone, sheet IDs, dimensions, hidden tabs. Use before edits and chart/format batch updates.',
        input_schema: { type: 'object', properties: { spreadsheet_id: idParam('Google Sheets spreadsheet ID.'), ranges: { type: 'array', items: { type: 'string' } }, include_grid_data: { type: 'boolean' } }, required: ['spreadsheet_id'] },
        tags: ['read', 'google-sheets', 'spreadsheet'],
    },
    {
        id: 'GoogleSheetsGetValues',
        name: 'GoogleSheetsGetValues',
        description: 'Reads values from one A1 range. Use exact ranges and headers before summaries, formulas, updates, charts, or data cleaning.',
        input_schema: valuesReadSchema(['spreadsheet_id', 'range']),
        tags: ['read', 'google-sheets', 'values'],
    },
    {
        id: 'GoogleSheetsBatchGetValues',
        name: 'GoogleSheetsBatchGetValues',
        description: 'Reads values from multiple A1 ranges in one call. Prefer for dashboards or multi-tab analysis.',
        input_schema: { type: 'object', properties: { spreadsheet_id: idParam('Spreadsheet ID.'), ranges: { type: 'array', items: { type: 'string' } }, value_render_option: renderOption(), date_time_render_option: dateTimeOption() }, required: ['spreadsheet_id', 'ranges'] },
        tags: ['read', 'google-sheets', 'values'],
    },
    {
        id: 'GoogleSheetsUpdateValues',
        name: 'GoogleSheetsUpdateValues',
        description: 'Updates one exact A1 range with a 2D array. Use after reading target cells and confirming the exact range and values.',
        input_schema: valuesWriteSchema(['spreadsheet_id', 'range', 'values', 'confirmed_by_user']),
        tags: ['write', 'google-sheets', 'values', 'external_action'],
    },
    {
        id: 'GoogleSheetsAppendValues',
        name: 'GoogleSheetsAppendValues',
        description: 'Appends rows to a table range. Use after confirming destination sheet/table and inserted rows.',
        input_schema: valuesWriteSchema(['spreadsheet_id', 'range', 'values', 'confirmed_by_user']),
        tags: ['write', 'google-sheets', 'values', 'external_action'],
    },
    {
        id: 'GoogleSheetsClearValues',
        name: 'GoogleSheetsClearValues',
        description: 'Clears values from an exact A1 range. Formatting remains. Requires explicit approval because data is removed.',
        input_schema: writeSchema({ spreadsheet_id: idParam('Spreadsheet ID.'), range: { type: 'string', description: 'A1 range to clear.' } }, ['spreadsheet_id', 'range', 'confirmed_by_user']),
        tags: ['write', 'google-sheets', 'values', 'destructive', 'external_action'],
    },
    {
        id: 'GoogleSheetsBatchUpdate',
        name: 'GoogleSheetsBatchUpdate',
        description: [
            'Advanced spreadsheet batchUpdate for production sheets: add/delete/duplicate sheets, update cells, repeatCell formatting, merge cells, borders, dimensions, filters, protected ranges, pivot tables, charts, slicers, conditional formatting, data validation, frozen panes, and auto-resize.',
            'Read metadata first, use exact sheetId/grid ranges, and verify with metadata/values afterward.',
        ].join(' '),
        input_schema: writeSchema({
            spreadsheet_id: idParam('Spreadsheet ID.'),
            requests: { type: 'array', items: { type: 'object' }, description: 'Raw Google Sheets API Request[] payload.' },
            include_spreadsheet_in_response: { type: 'boolean', description: 'Return updated spreadsheet in API response.' },
        }, ['spreadsheet_id', 'requests', 'confirmed_by_user']),
        tags: ['write', 'google-sheets', 'spreadsheet', 'external_action'],
    },
]

export async function executeGoogleSheetsCreateSpreadsheet(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Sheet')
    const title = stringArg(args, ['title', 'name'])
    if (!title) return missing('title')
    return { success: true, data: await googleSheetsCreateSpreadsheet(title, stringArrayArg(args, ['sheets', 'tabs'])) }
}

export async function executeGoogleSheetsGetSpreadsheet(args: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = stringArg(args, ['spreadsheet_id', 'spreadsheetId'])
    if (!spreadsheetId) return missing('spreadsheet_id')
    return { success: true, data: await googleSheetsGetSpreadsheet(spreadsheetId, booleanArg(args, ['include_grid_data', 'includeGridData']), stringArrayArg(args, ['ranges'])) }
}

export async function executeGoogleSheetsGetValues(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseRange(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleSheetsGetValues(parsed.spreadsheetId, parsed.range, parseReadOptions(args)) }
}

export async function executeGoogleSheetsBatchGetValues(args: Record<string, unknown>): Promise<ToolResult> {
    const spreadsheetId = stringArg(args, ['spreadsheet_id', 'spreadsheetId'])
    const ranges = stringArrayArg(args, ['ranges'])
    if (!spreadsheetId) return missing('spreadsheet_id')
    if (ranges.length === 0) return missing('ranges')
    return { success: true, data: await googleSheetsBatchGetValues(spreadsheetId, ranges, parseReadOptions(args)) }
}

export async function executeGoogleSheetsUpdateValues(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('updating Google Sheets values')
    const parsed = parseRangeValues(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleSheetsUpdateValues({ ...parsed.value, valueInputOption: valueInputOption(args), majorDimension: majorDimension(args) }) }
}

export async function executeGoogleSheetsAppendValues(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('appending Google Sheets values')
    const parsed = parseRangeValues(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleSheetsAppendValues({ ...parsed.value, valueInputOption: valueInputOption(args), insertDataOption: insertDataOption(args) }) }
}

export async function executeGoogleSheetsClearValues(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('clearing Google Sheets values')
    const parsed = parseRange(args)
    if (!parsed.ok) return parsed.error
    return { success: true, data: await googleSheetsClearValues(parsed.spreadsheetId, parsed.range) }
}

export async function executeGoogleSheetsBatchUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('running Google Sheets batchUpdate')
    const spreadsheetId = stringArg(args, ['spreadsheet_id', 'spreadsheetId'])
    if (!spreadsheetId) return missing('spreadsheet_id')
    if (!Array.isArray(args.requests)) return { success: false, error: 'requests must be an array.' }
    return { success: true, data: await googleSheetsBatchUpdate(spreadsheetId, args.requests, booleanArg(args, ['include_spreadsheet_in_response', 'includeSpreadsheetInResponse'])) }
}

function parseRange(args: Record<string, unknown>):
    | { ok: true; spreadsheetId: string; range: string }
    | { ok: false; error: ToolResult } {
    const spreadsheetId = stringArg(args, ['spreadsheet_id', 'spreadsheetId'])
    const range = stringArg(args, ['range'])
    if (!spreadsheetId) return { ok: false, error: missing('spreadsheet_id') }
    if (!range) return { ok: false, error: missing('range') }
    return { ok: true, spreadsheetId, range }
}

function parseRangeValues(args: Record<string, unknown>):
    | { ok: true; value: { spreadsheetId: string; range: string; values: unknown[][] } }
    | { ok: false; error: ToolResult } {
    const parsed = parseRange(args)
    if (!parsed.ok) return parsed
    const values = args.values
    if (!Array.isArray(values) || values.some(row => !Array.isArray(row))) return { ok: false, error: { success: false, error: 'values must be a 2D array.' } }
    return { ok: true, value: { ...parsed, values: values as unknown[][] } }
}

function parseReadOptions(args: Record<string, unknown>) {
    return {
        valueRenderOption: enumArg(args, ['value_render_option', 'valueRenderOption'], ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']),
        dateTimeRenderOption: enumArg(args, ['date_time_render_option', 'dateTimeRenderOption'], ['SERIAL_NUMBER', 'FORMATTED_STRING']),
    }
}

function valueInputOption(args: Record<string, unknown>): 'RAW' | 'USER_ENTERED' | undefined {
    return enumArg(args, ['value_input_option', 'valueInputOption'], ['RAW', 'USER_ENTERED'])
}

function majorDimension(args: Record<string, unknown>): 'ROWS' | 'COLUMNS' | undefined {
    return enumArg(args, ['major_dimension', 'majorDimension'], ['ROWS', 'COLUMNS'])
}

function insertDataOption(args: Record<string, unknown>): 'OVERWRITE' | 'INSERT_ROWS' | undefined {
    return enumArg(args, ['insert_data_option', 'insertDataOption'], ['OVERWRITE', 'INSERT_ROWS'])
}

function valuesReadSchema(required: string[]): ToolParameter {
    return { type: 'object', properties: { spreadsheet_id: idParam('Spreadsheet ID.'), range: { type: 'string', description: 'A1 notation range.' }, value_render_option: renderOption(), date_time_render_option: dateTimeOption() }, required }
}

function valuesWriteSchema(required: string[]): ToolParameter {
    return writeSchema({ spreadsheet_id: idParam('Spreadsheet ID.'), range: { type: 'string', description: 'A1 notation range.' }, values: { type: 'array', items: { type: 'array' }, description: '2D values array.' }, value_input_option: { type: 'string', enum: ['RAW', 'USER_ENTERED'] }, major_dimension: { type: 'string', enum: ['ROWS', 'COLUMNS'] }, insert_data_option: { type: 'string', enum: ['OVERWRITE', 'INSERT_ROWS'] } }, required)
}

function writeSchema(properties: Record<string, ToolParameter>, required: string[]): ToolParameter {
    return { type: 'object', properties: { ...properties, confirmed_by_user: { type: 'boolean', description: 'Must be true only after explicit approval for this exact Google Sheets write.' } }, required }
}

function renderOption(): ToolParameter {
    return { type: 'string', enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'] }
}

function dateTimeOption(): ToolParameter {
    return { type: 'string', enum: ['SERIAL_NUMBER', 'FORMATTED_STRING'] }
}

function idParam(description: string): ToolParameter {
    return { type: 'string', description }
}

function stringArrayArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function enumArg<T extends string>(args: Record<string, unknown>, keys: string[], allowed: readonly T[]): T | undefined {
    const value = stringArg(args, keys)
    return allowed.includes(value as T) ? value as T : undefined
}

function confirmed(args: Record<string, unknown>): boolean {
    return args.confirmed_by_user === true
}

function missing(name: string): ToolResult {
    return { success: false, error: `Missing required parameter: ${name}` }
}

function confirmationError(action: string): ToolResult {
    return { success: false, error: `confirmed_by_user must be true before ${action}.` }
}
