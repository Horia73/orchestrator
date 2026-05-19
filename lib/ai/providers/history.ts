import type { ProviderSendOptions } from '@/lib/ai/agents/types'

type ProviderMessage = ProviderSendOptions['messages'][number]

export function latestUserPromptWithPortableHistory(
    messages: ProviderSendOptions['messages'],
    hasProviderSession: boolean
): string {
    const message = latestUserMessageWithPortableHistory(messages, hasProviderSession)
    return message?.content ?? ''
}

export function latestUserMessageWithPortableHistory(
    messages: ProviderSendOptions['messages'],
    hasProviderSession: boolean
): ProviderMessage | null {
    const lastUserIndex = findLastUserIndex(messages)
    const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined
    if (!lastUser) return null

    if (hasProviderSession || lastUserIndex <= 0) return lastUser

    const history = messages.slice(0, lastUserIndex)
    const historyText = formatPortableHistory(history)
    if (!historyText) return lastUser

    return {
        ...lastUser,
        content: [
            '<conversation_history>',
            'This is the prior transcript from the same Orchestrator chat. Continue naturally using it as context; do not answer this section directly.',
            historyText,
            '</conversation_history>',
            '',
            '<new_user_message>',
            lastUser.content,
            '</new_user_message>',
        ].join('\n'),
    }
}

function findLastUserIndex(messages: ProviderSendOptions['messages']): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return i
    }
    return -1
}

function formatPortableHistory(messages: ProviderMessage[]): string {
    return messages
        .map((message) => {
            const content = message.content.trim()
            if (!content) return ''
            const role = message.role === 'assistant' ? 'assistant' : 'user'
            return `<${role}>\n${content}\n</${role}>`
        })
        .filter(Boolean)
        .join('\n\n')
}
