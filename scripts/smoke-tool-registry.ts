import assert from "node:assert/strict"

import { ALL_TOOL_DEFS } from "@/lib/ai/tools/tool-catalog"
import { getToolExecutor } from "@/lib/ai/tools/executors/registry"
import { orchestrator } from "@/lib/ai/agents/orchestrator"
import { researcher } from "@/lib/ai/agents/researcher"
import { worker } from "@/lib/ai/agents/worker"

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

assert.ok(orchestrator.tools.includes("delegate_async"), "Root Orchestrator must receive explicit async delegation")
assert.ok(orchestrator.tools.includes("manage_delegations"), "Root Orchestrator must manage async delegation")
for (const child of [researcher, worker]) {
  assert.ok(child.tools.includes("delegate_to") && child.tools.includes("delegate_parallel"), `${child.id} keeps synchronous delegation`)
  assert.equal(child.tools.includes("delegate_async"), false, `${child.id} must not receive root async launch`)
  assert.equal(child.tools.includes("manage_delegations"), false, `${child.id} must not receive root async management`)
}

console.log(`Tool registry contract OK (${ids.length} tools).`)
