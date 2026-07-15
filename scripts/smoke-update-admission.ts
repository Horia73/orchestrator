import assert from 'node:assert/strict'

import { clearAgentRun, listAgentRuns, registerAgentRun } from '@/lib/agent-runs'
import {
    clearChatStream,
    listActiveChatStreams,
    listAllActiveChatStreams,
    registerChatStream,
} from '@/lib/chat-streams'
import {
    blockAiRunAdmission,
    getAiRunAdmissionBlock,
    unblockAiRunAdmission,
} from '@/lib/ai/run-admission'
import { runWithProfileContext } from '@/lib/profiles/context'
import { ADMIN_PROFILE_ID } from '@/lib/profiles/constants'
import { canProfileReceivePendingUpdate } from '@/lib/update/manager'
import {
    chatUpdateRetryDelayMs,
    isChatUpdateInProgressResponse,
    sleepWithAbortSignal,
} from '@/hooks/chat-store-utils'
import {
    clearPendingChatUpdateTurn,
    isPendingChatUpdateStorageKey,
    PENDING_CHAT_UPDATE_TURN_MAX_AGE_MS,
    readPendingChatUpdateTurn,
    writePendingChatUpdateTurn,
} from '@/lib/chat-update-retry'
import type { Message } from '@/lib/types'

const stored = new Map<string, string>()
const retryStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
        stored.set(key, value)
    },
    removeItem: (key: string) => {
        stored.delete(key)
    },
}
const priorUser: Message = {
    id: 'update_prior_user',
    role: 'user',
    content: 'Already answered',
    timestamp: 100,
}
const priorAssistant: Message = {
    id: 'update_prior_assistant',
    role: 'assistant',
    content: 'Previous answer',
    timestamp: 200,
}
const pendingUser: Message = {
    id: 'update_pending_user',
    role: 'user',
    content: 'Send after update',
    timestamp: 300,
}
assert.equal(
    writePendingChatUpdateTurn(
        {
            profileId: 'admin',
            conversationId: 'update_pending_conversation',
            assistantMessageId: 'update_pending_assistant',
            messages: [priorUser, priorAssistant, pendingUser],
            queuedAt: 400,
        },
        retryStorage,
    ),
    true,
)
assert.deepEqual(
    readPendingChatUpdateTurn('admin', retryStorage, 500)?.messages.map((message) => message.id),
    [pendingUser.id],
    'refresh marker should retain only the unanswered user suffix',
)
assert.equal(
    clearPendingChatUpdateTurn(
        'admin',
        { assistantMessageId: 'different_assistant' },
        retryStorage,
    ),
    false,
    'an unrelated turn must not clear the pending retry',
)
assert.equal(
    readPendingChatUpdateTurn(
        'admin',
        retryStorage,
        400 + PENDING_CHAT_UPDATE_TURN_MAX_AGE_MS + 1,
    ),
    null,
    'stale refresh markers should expire instead of sending much later',
)
assert.equal(
    writePendingChatUpdateTurn(
        {
            profileId: 'member',
            conversationId: 'member_update_conversation',
            assistantMessageId: 'member_update_assistant',
            messages: [pendingUser],
            queuedAt: 600,
        },
        retryStorage,
    ),
    true,
)
assert.equal(
    writePendingChatUpdateTurn(
        {
            profileId: 'admin',
            conversationId: 'admin_update_conversation',
            assistantMessageId: 'admin_update_assistant',
            messages: [pendingUser],
            queuedAt: 600,
        },
        retryStorage,
    ),
    true,
)
assert.equal(
    readPendingChatUpdateTurn('admin', retryStorage, 700)?.conversationId,
    'admin_update_conversation',
    'one profile must never read another profile pending turn',
)
assert.equal(
    readPendingChatUpdateTurn('member', retryStorage, 700)?.conversationId,
    'member_update_conversation',
    'profile-scoped markers should survive independently',
)
assert.equal(
    [...stored.keys()].every((key) => isPendingChatUpdateStorageKey(key)),
    true,
    'other tabs should recognize profile-scoped pending-turn storage events',
)

assert.equal(
    isChatUpdateInProgressResponse(503, { code: 'update_in_progress' }),
    true,
)
assert.equal(
    isChatUpdateInProgressResponse(503, {
        error: 'Update in progress. The app will reconnect after restart.',
    }),
    true,
)
assert.equal(
    isChatUpdateInProgressResponse(502, null, false),
    true,
    'a non-JSON gateway response during web replacement must keep retrying',
)
assert.equal(
    isChatUpdateInProgressResponse(503, null, false),
    true,
    'a non-JSON service-unavailable response must keep retrying',
)
assert.equal(
    isChatUpdateInProgressResponse(504, null, false),
    true,
    'a non-JSON gateway timeout during restart must keep retrying',
)
assert.equal(
    isChatUpdateInProgressResponse(500, null, false),
    false,
    'an unrelated non-JSON server error must not retry forever',
)
assert.equal(
    isChatUpdateInProgressResponse(503, { error: 'Provider unavailable' }, true),
    false,
    'a structured application 503 must remain visible to the user',
)
assert.equal(isChatUpdateInProgressResponse(500, { code: 'update_in_progress' }), false)
assert.equal(chatUpdateRetryDelayMs('30'), 30_000)
assert.equal(chatUpdateRetryDelayMs('0'), 1_000)
assert.equal(chatUpdateRetryDelayMs(null), 5_000)

const retryAbort = new AbortController()
const abortedRetry = sleepWithAbortSignal(30_000, retryAbort.signal)
retryAbort.abort()
await assert.rejects(
    abortedRetry,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
)

const stamp = Date.now()
const adminConversation = `update_admission_admin_${stamp}`
const memberConversation = `update_admission_member_${stamp}`
const adminController = new AbortController()
const memberController = new AbortController()

assert.equal(canProfileReceivePendingUpdate(ADMIN_PROFILE_ID), true, 'admin may receive pending-update hints')
assert.equal(canProfileReceivePendingUpdate('member_test'), false, 'member agents must not receive pending-update hints')

assert.equal(
    runWithProfileContext({ profileId: ADMIN_PROFILE_ID }, () =>
        registerChatStream(adminConversation, 'admin_message', adminController, { announce: false })
    ),
    true,
)
assert.equal(
    runWithProfileContext({ profileId: 'member_test' }, () =>
        registerChatStream(memberConversation, 'member_message', memberController, { announce: false })
    ),
    true,
)

assert.equal(
    runWithProfileContext({ profileId: ADMIN_PROFILE_ID }, () => listActiveChatStreams().length),
    1,
    'profile-scoped API should remain scoped',
)
assert.equal(listAllActiveChatStreams().length, 2, 'update lifecycle must see every profile')

blockAiRunAdmission('update_smoke', 'Testing managed-update admission.')
assert.equal(getAiRunAdmissionBlock()?.owner, 'update_smoke')
assert.equal(
    registerChatStream(`blocked_chat_${stamp}`, 'blocked_message', new AbortController(), { announce: false }),
    false,
    'chat registration must close atomically during update handoff',
)
assert.equal(
    registerAgentRun({
        id: `blocked_agent_${stamp}`,
        kind: 'scheduled',
        conversationId: `blocked_agent_conversation_${stamp}`,
        startedAt: stamp,
    }),
    false,
    'scheduled/inbox registration must close atomically during update handoff',
)
assert.equal(listAllActiveChatStreams().length, 2, 'already-running streams must keep draining')
assert.equal(unblockAiRunAdmission('wrong_owner'), false, 'unrelated lifecycle cannot reopen admission')
assert.equal(unblockAiRunAdmission('update_smoke'), true)

const agentId = `allowed_agent_${stamp}`
assert.equal(
    registerAgentRun({
        id: agentId,
        kind: 'scheduled',
        conversationId: `allowed_agent_conversation_${stamp}`,
        startedAt: stamp,
    }),
    true,
)
assert.equal(listAgentRuns().some(run => run.id === agentId), true)
clearAgentRun(agentId)

runWithProfileContext({ profileId: ADMIN_PROFILE_ID }, () => clearChatStream(adminConversation, 'admin_message'))
runWithProfileContext({ profileId: 'member_test' }, () => clearChatStream(memberConversation, 'member_message'))

console.log('update admission smoke passed')
