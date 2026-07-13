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
