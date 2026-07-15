import assert from 'node:assert/strict'

import {
    browserAgentPauseKindFromContent,
    browserSessionIdFromRunContent,
    isBrowserAgentRunAwaitingUser,
    isBrowserAgentRunCheckpointed,
    isBrowserAgentRunLive,
} from '@/lib/browser-agent-run-state'
import type { AgentCallReasoningEntry } from '@/lib/types'

function run(content: string, status: AgentCallReasoningEntry['status'] = 'ok'): AgentCallReasoningEntry {
    return {
        type: 'agent_call',
        id: 'browser-run-smoke-entry',
        phase: 0,
        runId: 'browser-run-smoke',
        agentId: 'browser_agent',
        agentName: 'Browser Agent',
        kind: 'text',
        title: 'Browser smoke',
        prompt: 'Check the browser.',
        content,
        status,
        startedAt: Date.now(),
    }
}

assert.equal(browserAgentPauseKindFromContent('Session status: awaiting_user\nFinal action: ask'), 'takeover')
assert.equal(browserAgentPauseKindFromContent('Session status: awaiting_user\nFinal action: checkpoint'), 'checkpoint')
assert.equal(browserAgentPauseKindFromContent('Session status: awaiting_user'), 'takeover')
assert.equal(browserAgentPauseKindFromContent('Final action: ask'), 'none')
assert.equal(
    browserAgentPauseKindFromContent('Session status: awaiting_user\nFinal action: checkpoint\nFinal action: ask'),
    'takeover',
)

assert.equal(isBrowserAgentRunAwaitingUser(run('Session status: awaiting_user\nFinal action: ask')), true)
assert.equal(isBrowserAgentRunCheckpointed(run('Session status: awaiting_user\nFinal action: checkpoint')), true)
assert.equal(isBrowserAgentRunLive(run('ordinary progress', 'running')), true)
assert.equal(isBrowserAgentRunLive(run('Session status: awaiting_user\nFinal action: checkpoint')), true)
assert.equal(isBrowserAgentRunLive(run('completed', 'ok')), false)
assert.equal(browserSessionIdFromRunContent('Browser session: browser:abc-123'), 'browser:abc-123')
assert.equal(browserSessionIdFromRunContent('No session here.'), null)

console.log('browser agent run-state smoke passed')
