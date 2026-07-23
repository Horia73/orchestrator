import assert from 'node:assert/strict'

import {
    browserAgentPauseKindFromContent,
    browserSessionIdFromRun,
    browserSessionIdFromRunContent,
    isBrowserAgentRunAwaitingUser,
    isBrowserAgentRunCheckpointed,
    isBrowserAgentRunLive,
    isBrowserAgentRunWaitingInQueue,
    latestBrowserAgentRuns,
    latestBrowserAgentRunsFromReasoning,
    shouldAutoCloseBrowserAgentPanel,
} from '@/lib/browser-agent-run-state'
import type { AgentCallReasoningEntry } from '@/lib/types'

function run(
    content: string,
    status: AgentCallReasoningEntry['status'] = 'ok',
    options: { runId?: string; threadId?: string } = {},
): AgentCallReasoningEntry {
    return {
        type: 'agent_call',
        id: `browser-run-smoke-entry-${options.runId ?? 'default'}`,
        phase: 0,
        runId: options.runId ?? 'browser-run-smoke',
        agentThreadId: options.threadId,
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
assert.equal(shouldAutoCloseBrowserAgentPanel(run('ordinary progress', 'running')), false)
assert.equal(shouldAutoCloseBrowserAgentPanel(run('Session status: awaiting_user\nFinal action: ask', 'running')), true)
assert.equal(shouldAutoCloseBrowserAgentPanel(run('completed', 'ok')), true)
assert.equal(browserSessionIdFromRunContent('Browser session: browser:abc-123'), 'browser:abc-123')
assert.equal(browserSessionIdFromRunContent('No session here.'), null)
assert.equal(browserSessionIdFromRun({ ...run('', 'running'), browserSessionId: 'browser:owned' }), 'browser:owned')
assert.equal(isBrowserAgentRunWaitingInQueue({ ...run('', 'running'), queued: true }), true)
assert.equal(isBrowserAgentRunWaitingInQueue({
  ...run('', 'running'),
  reasoning: [{
    type: 'thought',
    id: 'browser-queue',
    phase: 0,
    content: '⏳ The browser is busy with another conversation. Your task is queued and will start automatically.',
  }],
}), true)
assert.equal(isBrowserAgentRunWaitingInQueue({
  ...run('', 'running'),
  browserSessionId: 'browser:started',
  reasoning: [{
    type: 'thought',
    id: 'old-browser-queue',
    phase: 0,
    content: 'The browser is busy with another conversation.',
  }],
}), false)

const oldTakeover = run(
    'Session status: awaiting_user\nFinal action: ask',
    'ok',
    { runId: 'old-takeover', threadId: 'thread-a' },
)
const continuedDone = run(
    'Session status: completed\nFinal action: done',
    'ok',
    { runId: 'continued-done', threadId: 'thread-a' },
)
const separateTakeover = run(
    'Session status: awaiting_user\nFinal action: ask',
    'ok',
    { runId: 'separate-takeover', threadId: 'thread-b' },
)

assert.deepEqual(
    latestBrowserAgentRuns([oldTakeover, continuedDone, separateTakeover]).map(entry => entry.runId),
    ['continued-done', 'separate-takeover'],
)
assert.deepEqual(
    latestBrowserAgentRunsFromReasoning([oldTakeover, continuedDone, separateTakeover])
        .filter(isBrowserAgentRunAwaitingUser)
        .map(entry => entry.runId),
    ['separate-takeover'],
)

console.log('browser agent run-state smoke passed')
