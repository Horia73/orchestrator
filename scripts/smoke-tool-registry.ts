import { ALL_TOOL_DEFS } from "@/lib/ai/tools/tool-catalog"
import { getToolExecutor } from "@/lib/ai/tools/executors/registry"

const ids = ALL_TOOL_DEFS.map((tool) => tool.id)
const seen = new Set<string>()
const duplicates = new Set<string>()

for (const id of ids) {
  if (seen.has(id)) duplicates.add(id)
  seen.add(id)
}

const missingExecutors = ids.filter((id) => !getToolExecutor(id))

if (duplicates.size > 0 || missingExecutors.length > 0) {
  if (duplicates.size > 0) {
    console.error(
      `Duplicate tool ids: ${Array.from(duplicates).sort().join(", ")}`
    )
  }
  if (missingExecutors.length > 0) {
    console.error(`Missing executors: ${missingExecutors.sort().join(", ")}`)
  }
  process.exit(1)
}

console.log(`Tool registry contract OK (${ids.length} tools).`)
