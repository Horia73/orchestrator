import { googleWorkspaceJson } from './google-drive'

const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4'

export interface GoogleSheetsSpreadsheetSummary {
    spreadsheetId: string
    title: string
    locale: string | null
    timeZone: string | null
    url: string
    sheets: Array<{
        sheetId: number
        title: string
        index: number
        sheetType: string
        rowCount: number
        columnCount: number
        frozenRowCount: number
        frozenColumnCount: number
        hidden: boolean
    }>
}

export interface GoogleSheetsValuesResult {
    spreadsheetId: string
    range: string
    majorDimension: string
    values: unknown[][]
}

interface SheetsSpreadsheet {
    spreadsheetId?: string
    spreadsheetUrl?: string
    properties?: {
        title?: string
        locale?: string
        timeZone?: string
    }
    sheets?: Array<{
        properties?: {
            sheetId?: number
            title?: string
            index?: number
            sheetType?: string
            hidden?: boolean
            gridProperties?: {
                rowCount?: number
                columnCount?: number
                frozenRowCount?: number
                frozenColumnCount?: number
            }
        }
    }>
}

interface SheetsValuesResponse {
    spreadsheetId?: string
    range?: string
    majorDimension?: string
    values?: unknown[][]
    updatedRange?: string
    updatedRows?: number
    updatedColumns?: number
    updatedCells?: number
    tableRange?: string
    updates?: SheetsValuesResponse
}

export async function googleSheetsCreateSpreadsheet(title: string, sheets: string[] = []): Promise<GoogleSheetsSpreadsheetSummary> {
    const body: Record<string, unknown> = {
        properties: { title: cleanRequired(title, 'title') },
    }
    const cleanSheets = sheets.map(item => item.trim()).filter(Boolean)
    if (cleanSheets.length > 0) {
        body.sheets = cleanSheets.map(sheetTitle => ({ properties: { title: sheetTitle } }))
    }
    const spreadsheet = await googleWorkspaceJson<SheetsSpreadsheet>(GOOGLE_SHEETS_API_BASE, '/spreadsheets', {
        method: 'POST',
        body: JSON.stringify(body),
    })
    return summarizeSpreadsheet(spreadsheet)
}

export async function googleSheetsGetSpreadsheet(spreadsheetId: string, includeGridData = false, ranges: string[] = []): Promise<GoogleSheetsSpreadsheetSummary> {
    const params = new URLSearchParams({
        includeGridData: String(includeGridData),
    })
    for (const range of ranges) {
        const clean = range.trim()
        if (clean) params.append('ranges', clean)
    }
    const spreadsheet = await googleWorkspaceJson<SheetsSpreadsheet>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(spreadsheetId, 'spreadsheet_id'))}?${params.toString()}`
    )
    return summarizeSpreadsheet(spreadsheet)
}

export async function googleSheetsGetValues(spreadsheetId: string, range: string, options: {
    majorDimension?: 'ROWS' | 'COLUMNS'
    valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'
    dateTimeRenderOption?: 'SERIAL_NUMBER' | 'FORMATTED_STRING'
} = {}): Promise<GoogleSheetsValuesResult> {
    const params = new URLSearchParams()
    if (options.majorDimension) params.set('majorDimension', options.majorDimension)
    if (options.valueRenderOption) params.set('valueRenderOption', options.valueRenderOption)
    if (options.dateTimeRenderOption) params.set('dateTimeRenderOption', options.dateTimeRenderOption)
    const result = await googleWorkspaceJson<SheetsValuesResponse>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(spreadsheetId, 'spreadsheet_id'))}/values/${encodeURIComponent(cleanRequired(range, 'range'))}?${params.toString()}`
    )
    return summarizeValues(spreadsheetId, result)
}

export async function googleSheetsBatchGetValues(spreadsheetId: string, ranges: string[], options: {
    valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'
    dateTimeRenderOption?: 'SERIAL_NUMBER' | 'FORMATTED_STRING'
} = {}) {
    const cleanRanges = ranges.map(item => item.trim()).filter(Boolean)
    if (cleanRanges.length === 0) throw new Error('At least one range is required.')
    const params = new URLSearchParams()
    for (const range of cleanRanges) params.append('ranges', range)
    if (options.valueRenderOption) params.set('valueRenderOption', options.valueRenderOption)
    if (options.dateTimeRenderOption) params.set('dateTimeRenderOption', options.dateTimeRenderOption)
    const result = await googleWorkspaceJson<{ spreadsheetId?: string; valueRanges?: SheetsValuesResponse[] }>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(spreadsheetId, 'spreadsheet_id'))}/values:batchGet?${params.toString()}`
    )
    return {
        spreadsheetId: result.spreadsheetId ?? spreadsheetId,
        valueRanges: (result.valueRanges ?? []).map(item => summarizeValues(spreadsheetId, item)),
    }
}

export async function googleSheetsUpdateValues(args: {
    spreadsheetId: string
    range: string
    values: unknown[][]
    valueInputOption?: 'RAW' | 'USER_ENTERED'
    majorDimension?: 'ROWS' | 'COLUMNS'
}) {
    const params = new URLSearchParams({ valueInputOption: args.valueInputOption ?? 'USER_ENTERED' })
    const result = await googleWorkspaceJson<SheetsValuesResponse>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(args.spreadsheetId, 'spreadsheet_id'))}/values/${encodeURIComponent(cleanRequired(args.range, 'range'))}?${params.toString()}`,
        {
            method: 'PUT',
            body: JSON.stringify({
                range: args.range,
                majorDimension: args.majorDimension ?? 'ROWS',
                values: assertValues(args.values),
            }),
        }
    )
    return result
}

export async function googleSheetsAppendValues(args: {
    spreadsheetId: string
    range: string
    values: unknown[][]
    valueInputOption?: 'RAW' | 'USER_ENTERED'
    insertDataOption?: 'OVERWRITE' | 'INSERT_ROWS'
}) {
    const params = new URLSearchParams({
        valueInputOption: args.valueInputOption ?? 'USER_ENTERED',
        insertDataOption: args.insertDataOption ?? 'INSERT_ROWS',
    })
    return googleWorkspaceJson<SheetsValuesResponse>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(args.spreadsheetId, 'spreadsheet_id'))}/values/${encodeURIComponent(cleanRequired(args.range, 'range'))}:append?${params.toString()}`,
        {
            method: 'POST',
            body: JSON.stringify({ values: assertValues(args.values) }),
        }
    )
}

export async function googleSheetsClearValues(spreadsheetId: string, range: string) {
    return googleWorkspaceJson<SheetsValuesResponse>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(spreadsheetId, 'spreadsheet_id'))}/values/${encodeURIComponent(cleanRequired(range, 'range'))}:clear`,
        { method: 'POST', body: JSON.stringify({}) }
    )
}

export async function googleSheetsBatchUpdate(spreadsheetId: string, requests: unknown[], includeSpreadsheetInResponse = false) {
    if (!Array.isArray(requests) || requests.length === 0) throw new Error('Google Sheets batchUpdate requires at least one request.')
    return googleWorkspaceJson<unknown>(
        GOOGLE_SHEETS_API_BASE,
        `/spreadsheets/${encodeURIComponent(cleanRequired(spreadsheetId, 'spreadsheet_id'))}:batchUpdate`,
        {
            method: 'POST',
            body: JSON.stringify({
                requests,
                includeSpreadsheetInResponse,
            }),
        }
    )
}

function summarizeSpreadsheet(spreadsheet: SheetsSpreadsheet): GoogleSheetsSpreadsheetSummary {
    const spreadsheetId = spreadsheet.spreadsheetId ?? ''
    return {
        spreadsheetId,
        title: spreadsheet.properties?.title ?? '',
        locale: spreadsheet.properties?.locale ?? null,
        timeZone: spreadsheet.properties?.timeZone ?? null,
        url: spreadsheet.spreadsheetUrl || (spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : ''),
        sheets: (spreadsheet.sheets ?? []).map(sheet => {
            const props = sheet.properties ?? {}
            const grid = props.gridProperties ?? {}
            return {
                sheetId: props.sheetId ?? 0,
                title: props.title ?? '',
                index: props.index ?? 0,
                sheetType: props.sheetType ?? '',
                rowCount: grid.rowCount ?? 0,
                columnCount: grid.columnCount ?? 0,
                frozenRowCount: grid.frozenRowCount ?? 0,
                frozenColumnCount: grid.frozenColumnCount ?? 0,
                hidden: props.hidden === true,
            }
        }),
    }
}

function summarizeValues(spreadsheetId: string, result: SheetsValuesResponse): GoogleSheetsValuesResult {
    return {
        spreadsheetId: result.spreadsheetId ?? spreadsheetId,
        range: result.range ?? '',
        majorDimension: result.majorDimension ?? 'ROWS',
        values: result.values ?? [],
    }
}

function assertValues(values: unknown[][]): unknown[][] {
    if (!Array.isArray(values) || values.some(row => !Array.isArray(row))) {
        throw new Error('values must be a 2D array.')
    }
    return values
}

function cleanRequired(value: string | undefined, name: string): string {
    const clean = (value ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!clean) throw new Error(`Missing required parameter: ${name}`)
    return clean
}
