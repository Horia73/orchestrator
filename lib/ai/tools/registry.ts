import type {
  ProviderBuiltin,
  ProviderCapabilities,
  ToolDef,
} from "@/lib/ai/agents/types"
import {
  ALL_TOOL_DEFS,
  BUILTIN_TOOL_IDS,
  NATIVE_BUILTIN_DUPLICATE_TOOL_IDS,
} from "./tool-catalog"
import {
  getActiveProfilePermissions,
  isToolAllowedForActiveProfile,
} from "@/lib/profiles/permissions"

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

const tools = new Map<string, ToolDef>(
  ALL_TOOL_DEFS.map((tool) => [tool.id, tool])
)

export function getTool(id: string): ToolDef | undefined {
  return tools.get(id)
}

/** Get tools that an agent is allowed to use, given its tool ID list. */
export function getToolsForAgent(toolIds: string[]): ToolDef[] {
  return toolIds
    .map((id) => tools.get(id))
    .filter((t): t is ToolDef => t !== undefined)
    .filter(isToolAllowedForActiveProfile)
}

export function getToolsForBuiltins(
  builtins: ProviderBuiltin[] | undefined
): ToolDef[] {
  if (!builtins?.length) return []
  return dedupeTools(
    builtins
      .flatMap((builtin) => BUILTIN_TOOL_IDS[builtin] ?? [])
      .map((id) => tools.get(id))
      .filter((t): t is ToolDef => t !== undefined)
      .filter(isToolAllowedForActiveProfile)
  )
}

export function getAllowedProviderBuiltins(
  builtins: ProviderBuiltin[] | undefined
): ProviderBuiltin[] {
  if (!builtins?.length) return []
  const permissions = getActiveProfilePermissions()
  if (!permissions) return [...builtins]
  return builtins.filter((builtin) => {
    if (builtin === "read" || builtin === "glob" || builtin === "grep" || builtin === "file_search") {
      return permissions.tools.read_files
    }
    if (builtin === "write" || builtin === "edit") {
      return permissions.tools.write_files
    }
    if (builtin === "bash" || builtin === "code_execution") {
      return permissions.tools.shell
    }
    if (builtin === "web_fetch" || builtin === "web_search" || builtin === "url_context") {
      return permissions.tools.web_access
    }
    return true
  })
}

export function resolveProviderToolSurface(
  candidateTools: ToolDef[],
  requestedBuiltins: ProviderBuiltin[] | undefined,
  capabilities: ProviderCapabilities
): { tools: ToolDef[]; builtins: ProviderBuiltin[] } {
  const nativeBuiltins = nativeBuiltinsForProvider(
    requestedBuiltins,
    capabilities
  )
  const toolsWithNativeDedupe = removeNativeBuiltinToolDuplicates(
    candidateTools,
    nativeBuiltins
  )

  if (
    capabilities.nativeBuiltinsCanMixWithFunctionTools === false &&
    toolsWithNativeDedupe.length > 0
  ) {
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
  const duplicateIds = new Set(
    nativeBuiltins.flatMap(
      (builtin) => NATIVE_BUILTIN_DUPLICATE_TOOL_IDS[builtin] ?? []
    )
  )
  if (duplicateIds.size === 0) return candidateTools
  return candidateTools.filter((tool) => !duplicateIds.has(tool.id))
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
