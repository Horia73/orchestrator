function envPath(args: Record<string, unknown> | undefined): string {
    const raw = typeof args?.path === 'string'
        ? args.path
        : typeof args?.file_path === 'string' ? args.file_path : ''
    return raw.replaceAll('\\', '/')
}

function isEnvLocalPath(args: Record<string, unknown> | undefined): boolean {
    const p = envPath(args)
    return p === '.env.local' || p.endsWith('/.env.local')
}

export function redactToolArgs(
    toolName: string,
    args: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!args) return args

    if (toolName === 'SetEnv') {
        return { ...args, value: '[redacted]' }
    }

    if ((toolName === 'Write' || toolName === 'Edit') && isEnvLocalPath(args)) {
        const redacted = { ...args }
        if ('content' in redacted) redacted.content = '[redacted env content]'
        if ('old_string' in redacted) redacted.old_string = '[redacted env content]'
        if ('new_string' in redacted) redacted.new_string = '[redacted env content]'
        return redacted
    }

    return args
}
