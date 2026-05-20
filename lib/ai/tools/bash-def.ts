import type { ToolDef } from '@/lib/ai/agents/types'

export const bashTool: ToolDef = {
    id: 'Bash',
    name: 'Bash',
    description: 'Runs a shell command in the writable agent workspace. Use for build/test/search commands. Foreground commands are timed out and output-limited; background commands return a log path.',
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to run.',
            },
            description: {
                type: 'string',
                description: 'Short human-readable purpose for the command.',
            },
            timeout: {
                type: 'integer',
                description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'When true, start the command and return immediately with a log path.',
            },
            cwd: {
                type: 'string',
                description: 'Optional working directory inside the writable workspace. Defaults to the workspace root.',
            },
        },
        required: ['command'],
    },
    tags: ['execute', 'shell'],
}
