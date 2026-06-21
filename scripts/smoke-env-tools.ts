import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-tools-smoke-'))
process.env.ORCHESTRATOR_STATE_DIR = path.join(tmpRoot, 'state')

const originalProcessSecret = process.env.SHOPIFY_PROCESS_SMOKE_TOKEN
process.env.SHOPIFY_PROCESS_SMOKE_TOKEN = 'process-secret-456'

async function main(): Promise<void> {
    const { activeRuntimePaths } = await import('@/lib/runtime-paths')
    const {
        executeListEnvVars,
        resolveEnvVarInjection,
        createSecretStreamRedactor,
        collectEnvKeys,
    } = await import('@/lib/ai/tools/env-vars')
    const { executeBash } = await import('@/lib/ai/tools/bash')

    const workspace = activeRuntimePaths().agentWorkspaceDir
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(
        activeRuntimePaths().workspaceEnvPath,
        [
            'SHOPIFY_THEME_SMOKE_PASSWORD="super-secret-123"',
            'EMPTY_SMOKE_VAR=',
            'DUPLICATE_SMOKE_VAR=old',
            'DUPLICATE_SMOKE_VAR=new-secret-789',
            '',
        ].join('\n'),
        { mode: 0o600 },
    )

    let failures = 0
    function check(label: string, condition: unknown, detail?: unknown): void {
        if (condition) {
            console.log(`ok ${label}`)
            return
        }
        failures += 1
        console.error(`FAIL ${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    }

    const listed = executeListEnvVars({ query: 'SHOPIFY' })
    check('ListEnvVars succeeds', listed.success)
    const listedData = listed.data as { entries: Array<{ key: string; has_value: boolean; sources: string[] }> }
    check('ListEnvVars returns workspace key', listedData.entries.some(row => row.key === 'SHOPIFY_THEME_SMOKE_PASSWORD' && row.has_value && row.sources.includes('workspace')), listed.data)
    check('ListEnvVars does not reveal workspace secret', !JSON.stringify(listed.data).includes('super-secret-123'), listed.data)

    const listedProcess = executeListEnvVars({ query: 'SHOPIFY_PROCESS', include_process: true })
    const listedProcessData = listedProcess.data as { entries: Array<{ key: string; has_value: boolean; sources: string[] }> }
    check('ListEnvVars can include process names', listedProcessData.entries.some(row => row.key === 'SHOPIFY_PROCESS_SMOKE_TOKEN' && row.has_value && row.sources.includes('process')), listedProcess.data)
    check('ListEnvVars does not reveal process secret', !JSON.stringify(listedProcess.data).includes('process-secret-456'), listedProcess.data)

    const resolved = resolveEnvVarInjection(['SHOPIFY_THEME_SMOKE_PASSWORD', 'DUPLICATE_SMOKE_VAR'])
    check('env injection resolves workspace values', resolved.ok)
    if (resolved.ok) {
        check('duplicate env resolution uses last non-empty value', resolved.injection.env.DUPLICATE_SMOKE_VAR === 'new-secret-789', resolved.injection)
    }
    check('env key parser accepts CSV strings', collectEnvKeys({ env_keys: 'SHOPIFY_THEME_SMOKE_PASSWORD,DUPLICATE_SMOKE_VAR' }).length === 2)

    const missing = resolveEnvVarInjection(['MISSING_SMOKE_VAR'])
    check('env injection rejects missing names', !missing.ok && missing.missing?.includes('MISSING_SMOKE_VAR'), missing)

    const redactor = createSecretStreamRedactor([
        { key: 'SPLIT_SECRET', value: 'split-secret-value', marker: '[redacted:SPLIT_SECRET]' },
    ])
    const splitOutput = redactor.push('before split-sec') + redactor.push('ret-value after') + redactor.flush()
    check('stream redactor handles split secrets', splitOutput === 'before [redacted:SPLIT_SECRET] after', splitOutput)

    const bashResult = await executeBash({
        command: 'printf "%s" "$SHOPIFY_THEME_SMOKE_PASSWORD"',
        env_keys: ['SHOPIFY_THEME_SMOKE_PASSWORD'],
        timeout: 10_000,
    })
    check('Bash env_keys command succeeds', bashResult.success, bashResult)
    const bashText = JSON.stringify(bashResult)
    check('Bash output redacts injected secret', !bashText.includes('super-secret-123') && bashText.includes('[redacted:SHOPIFY_THEME_SMOKE_PASSWORD]'), bashResult)

    const bashMissing = await executeBash({
        command: 'printf nope',
        env_keys: ['MISSING_SMOKE_VAR'],
        timeout: 10_000,
    })
    check('Bash env_keys fails before running when missing', !bashMissing.success && bashMissing.error?.includes('MISSING_SMOKE_VAR'), bashMissing)

    if (failures > 0) process.exit(1)
    console.log('Env tools smoke passed.')
}

main()
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
    .finally(() => {
        if (originalProcessSecret === undefined) delete process.env.SHOPIFY_PROCESS_SMOKE_TOKEN
        else process.env.SHOPIFY_PROCESS_SMOKE_TOKEN = originalProcessSecret
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    })
