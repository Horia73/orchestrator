import assert from 'node:assert/strict'

import {
    directChildAgentRuns,
    isNestedAgentRun,
} from '@/lib/agent-hierarchy'
import {
    distinctAgentRoleAndNames,
    distinctAssignedName,
} from '@/lib/agent-label'
import type { AgentCallReasoningEntry } from '@/lib/types'

function run(
    runId: string,
    assignedName: string,
    parentRunId?: string,
): AgentCallReasoningEntry {
    return {
        type: 'agent_call',
        id: `agent_${runId}`,
        phase: 0,
        runId,
        parentRunId,
        agentId: 'researcher',
        agentName: 'Researcher',
        assignedName,
        kind: 'text',
        title: 'Researcher',
        prompt: 'test',
        status: 'running',
        startedAt: 1,
        content: '',
    }
}

const parent = run('parent', 'Marco')
const child = run('child', 'Marco', parent.runId)
const sibling = run('sibling', 'Marco', parent.runId)
const grandchild = run('grandchild', 'Mara', child.runId)
const synthetic = run('synthetic', 'Audio', 'assistant_message_id')
const all = [parent, child, sibling, grandchild, synthetic]
const ids = new Set(all.map(entry => entry.runId))

assert.equal(isNestedAgentRun(parent, ids), false)
assert.equal(isNestedAgentRun(child, ids), true)
assert.equal(isNestedAgentRun(grandchild, ids), true)
assert.equal(
    isNestedAgentRun(synthetic, ids),
    false,
    'a synthetic message parent is not an agent hierarchy edge',
)
assert.deepEqual(
    directChildAgentRuns(all, parent.runId).map(entry => entry.runId),
    ['child', 'sibling'],
    'a parent panel must receive direct children only',
)
assert.deepEqual(
    directChildAgentRuns(all, child.runId).map(entry => entry.runId),
    ['grandchild'],
    'the next generation belongs only to the child panel',
)
assert.deepEqual(
    distinctAgentRoleAndNames([child, sibling], [parent]),
    ['Researcher Marco · 2', 'Researcher Marco · 3'],
    'historical duplicate names remain distinguishable in the UI',
)
assert.equal(distinctAssignedName('Marco', ['Marco']), 'Marco-2')
assert.equal(distinctAssignedName('Marco-2', ['Marco', 'Marco-2']), 'Marco-3')
assert.equal(distinctAssignedName('Mara', ['Marco']), 'Mara')

console.log('Agent hierarchy smoke passed')
