import type { ProviderBuiltin, ProviderCapabilities, ToolDef } from '@/lib/ai/agents/types'
import { listDirTool } from './list-dir'
import { readFileTool } from './read-file'
import { delegateParallelTool, delegateToTool } from './delegate-to'
import { readTool } from './read'
import { writeTool } from './write'
import { editTool } from './edit'
import { bashTool } from './bash-def'
import { globTool } from './glob'
import { grepTool } from './grep'
import { webFetchTool } from './web'
import { todoWriteTool } from './todo-write'
import { reportAgentNeedTool } from './agent-needs'
import { setEnvTool } from './set-env'
import { activateIntegrationToolsTool, runActivatedIntegrationTool } from './integrations'
import { gmailTools } from './gmail'
import { googleCalendarTools } from './google-calendar'
import { googleContactsTools } from './google-contacts'
import { googleDocsTools } from './google-docs'
import { googleDriveTools } from './google-drive'
import { googleSheetsTools } from './google-sheets'
import { googleSlidesTools } from './google-slides'
import { homeAssistantTools } from './home-assistant'
import { whatsappTools } from './whatsapp'
import { scheduleTools } from './schedule'
import { observabilityTools } from './observability'
import { notifyInboxTool } from './notify'
import { inboxActionHistoryTool } from './inbox-history'
import { setTaskStateTool } from './task-state'
import { watchlistTools } from './watchlist'
import { monitorWakeFeedbackTool } from './smart-monitor-feedback'
import { smartMonitorManageTools } from './smart-monitor-manage'
import { microscriptTools } from './microscripts'
import {
    mapRenderTool,
    mapsCurrentLocationTool,
    mapsDirectionsTool,
    mapsGeocodeTool,
    mapsListLocationSourcesTool,
    mapsOptimizeStopsTool,
    mapsPlacesTool,
    mapsReverseGeocodeTool,
    mapsSetLocationSourceTool,
    mapsStatusTool,
} from './maps'
import { weatherSetCalendarContextTool, weatherSetOutfitTool, weatherSetWhyTool, weatherShowTool, weatherStatusTool } from './weather'
import { getExerciseHistoryTool, getRecentWorkoutsTool, listExerciseHistoryTool } from './workout-history'
import { applyUpdateTool } from './update-app'

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

const tools = new Map<string, ToolDef>()

function registerTool(tool: ToolDef) {
    tools.set(tool.id, tool)
}

export function getTool(id: string): ToolDef | undefined {
    return tools.get(id)
}

/** Get tools that an agent is allowed to use, given its tool ID list */
export function getToolsForAgent(toolIds: string[]): ToolDef[] {
    return toolIds
        .map(id => tools.get(id))
        .filter((t): t is ToolDef => t !== undefined)
}

export function getToolsForBuiltins(builtins: ProviderBuiltin[] | undefined): ToolDef[] {
    if (!builtins?.length) return []
    return dedupeTools(builtins
        .flatMap(builtin => BUILTIN_TOOL_IDS[builtin] ?? [])
        .map(id => tools.get(id))
        .filter((t): t is ToolDef => t !== undefined))
}

export function resolveProviderToolSurface(
    candidateTools: ToolDef[],
    requestedBuiltins: ProviderBuiltin[] | undefined,
    capabilities: ProviderCapabilities
): { tools: ToolDef[]; builtins: ProviderBuiltin[] } {
    const nativeBuiltins = nativeBuiltinsForProvider(requestedBuiltins, capabilities)
    const toolsWithNativeDedupe = removeNativeBuiltinToolDuplicates(candidateTools, nativeBuiltins)

    if (capabilities.nativeBuiltinsCanMixWithFunctionTools === false && toolsWithNativeDedupe.length > 0) {
        return {
            tools: candidateTools,
            builtins: [],
        }
    }

    return {
        tools: toolsWithNativeDedupe,
        builtins: nativeBuiltins,
    }
}

export function nativeBuiltinsForProvider(
    requestedBuiltins: ProviderBuiltin[] | undefined,
    capabilities: ProviderCapabilities
): ProviderBuiltin[] {
    if (!requestedBuiltins?.length) return []
    const supported = new Set(capabilities.nativeBuiltins)
    const seen = new Set<ProviderBuiltin>()
    const out: ProviderBuiltin[] = []
    for (const builtin of requestedBuiltins) {
        if (!supported.has(builtin) || seen.has(builtin)) continue
        seen.add(builtin)
        out.push(builtin)
    }
    return out
}

export function removeNativeBuiltinToolDuplicates(
    candidateTools: ToolDef[],
    nativeBuiltins: ProviderBuiltin[]
): ToolDef[] {
    if (nativeBuiltins.length === 0) return candidateTools
    const duplicateIds = new Set(nativeBuiltins.flatMap(builtin => NATIVE_BUILTIN_DUPLICATE_TOOL_IDS[builtin] ?? []))
    if (duplicateIds.size === 0) return candidateTools
    return candidateTools.filter(tool => !duplicateIds.has(tool.id))
}

function dedupeTools(items: ToolDef[]): ToolDef[] {
    const seen = new Set<string>()
    const out: ToolDef[] = []
    for (const item of items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push(item)
    }
    return out
}

const BUILTIN_TOOL_IDS: Partial<Record<ProviderBuiltin, string[]>> = {
    read: ['Read'],
    write: ['Write'],
    edit: ['Edit'],
    bash: ['Bash'],
    glob: ['Glob'],
    grep: ['Grep'],
    web_fetch: ['WebFetch'],
    url_context: ['WebFetch'],
    todo_write: ['TodoWrite'],
}

const NATIVE_BUILTIN_DUPLICATE_TOOL_IDS: Partial<Record<ProviderBuiltin, string[]>> = {
    read: ['list_dir', 'read_file', 'Read'],
    write: ['Write'],
    edit: ['Edit'],
    bash: ['Bash'],
    glob: ['Glob'],
    grep: ['Grep'],
    web_fetch: ['WebFetch'],
    url_context: ['WebFetch'],
    todo_write: ['TodoWrite'],
}

// ---------------------------------------------------------------------------
// Register built-in tools
// ---------------------------------------------------------------------------

registerTool(listDirTool)
registerTool(readFileTool)
registerTool(delegateToTool)
registerTool(delegateParallelTool)
registerTool(readTool)
registerTool(writeTool)
registerTool(editTool)
registerTool(bashTool)
registerTool(globTool)
registerTool(grepTool)
registerTool(webFetchTool)
registerTool(todoWriteTool)
registerTool(reportAgentNeedTool)
registerTool(setEnvTool)
registerTool(activateIntegrationToolsTool)
registerTool(runActivatedIntegrationTool)
for (const tool of gmailTools) registerTool(tool)
for (const tool of googleCalendarTools) registerTool(tool)
for (const tool of googleDriveTools) registerTool(tool)
for (const tool of googleContactsTools) registerTool(tool)
for (const tool of googleDocsTools) registerTool(tool)
for (const tool of googleSheetsTools) registerTool(tool)
for (const tool of googleSlidesTools) registerTool(tool)
for (const tool of whatsappTools) registerTool(tool)
for (const tool of homeAssistantTools) registerTool(tool)
for (const tool of scheduleTools) registerTool(tool)
for (const tool of observabilityTools) registerTool(tool)
registerTool(notifyInboxTool)
registerTool(inboxActionHistoryTool)
registerTool(setTaskStateTool)
for (const tool of watchlistTools) registerTool(tool)
registerTool(monitorWakeFeedbackTool)
for (const tool of smartMonitorManageTools) registerTool(tool)
for (const tool of microscriptTools) registerTool(tool)
registerTool(mapsStatusTool)
registerTool(mapsCurrentLocationTool)
registerTool(mapsListLocationSourcesTool)
registerTool(mapsSetLocationSourceTool)
registerTool(mapsGeocodeTool)
registerTool(mapsReverseGeocodeTool)
registerTool(mapsPlacesTool)
registerTool(mapsOptimizeStopsTool)
registerTool(mapsDirectionsTool)
registerTool(mapRenderTool)
registerTool(weatherStatusTool)
registerTool(weatherShowTool)
registerTool(weatherSetOutfitTool)
registerTool(weatherSetWhyTool)
registerTool(weatherSetCalendarContextTool)
registerTool(getExerciseHistoryTool)
registerTool(listExerciseHistoryTool)
registerTool(getRecentWorkoutsTool)
registerTool(applyUpdateTool)
