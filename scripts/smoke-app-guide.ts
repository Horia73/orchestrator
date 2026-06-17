/**
 * Smoke tests for the App & host guide subsystem and the self-service backup
 * tool (lib/ai/tools/create-backup.ts, lib/ai/tools/host-status.ts,
 * lib/integrations/doctrines/app-guide.ts).
 *
 * Runs against a throwaway state dir so create_backup operates on an isolated,
 * empty instance instead of the dev workspace. We set ORCHESTRATOR_STATE_DIR
 * BEFORE importing anything that resolves runtime paths / opens the DB, then
 * dynamically import the modules under test. Exercises:
 *  - host_status: returns a live snapshot with disk/memory/host shape, no throw.
 *  - create_backup: produces a .tar.gz under the Library files/ dir, prunes a
 *    pre-existing backup, and never deletes unrelated user files.
 *  - wiring: both tools registered; host_status gated behind app_guide while
 *    create_backup stays always-on; app_guide is a valid activation id with a
 *    non-empty doctrine.
 *
 * Run: npx tsx scripts/smoke-app-guide.ts
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import zlib from 'zlib'

import { extract as tarExtract } from 'tar-stream'

async function main() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-smoke-appguide-'))
    process.env.ORCHESTRATOR_STATE_DIR = stateDir

    try {
        // Dynamic imports AFTER the env is set so runtime-paths/db resolve here.
        const { executeHostStatus, hostStatusTool } = await import('@/lib/ai/tools/host-status')
        const { executeCreateBackup, createBackupTool } = await import('@/lib/ai/tools/create-backup')
        const { getTool, getToolsForAgent } = await import('@/lib/ai/tools/registry')
        const { ALL_SUBSYSTEM_IDS, getSubsystemManifest, subsystemForGatedTool } = await import('@/lib/integrations/subsystem-manifest')
        const { ALL_CAPABILITY_IDS, filterIntegrationToolExposure } = await import('@/lib/integrations/exposure')
        const { activateIntegrations } = await import('@/lib/integrations/activation-store')
        const { AGENT_WORKSPACE_DIR, PRIVATE_STATE_DIR } = await import('@/lib/config')

        // --- host_status -----------------------------------------------------
        const host = await executeHostStatus()
        assert.strictEqual(host.success, true, 'host_status should succeed')
        const hostData = host.data as {
            host: { hostname: string }
            memory: { total: string }
            disk: unknown[]
            disk_pressure: string
            process: { node_version: string }
        }
        assert.ok(hostData.host?.hostname, 'host_status reports a hostname')
        assert.ok(typeof hostData.memory?.total === 'string', 'host_status reports total memory')
        assert.ok(Array.isArray(hostData.disk) && hostData.disk.length > 0, 'host_status reports at least one filesystem')
        assert.ok(typeof hostData.disk_pressure === 'string', 'host_status reports a disk_pressure verdict')
        assert.ok(typeof hostData.process?.node_version === 'string', 'host_status reports node version')
        console.log(`  host_status: ${hostData.disk.length} fs, mem ${hostData.memory.total}, "${hostData.disk_pressure.slice(0, 48)}…"`)

        // --- create_backup: seed a stray user file + a fake old backup -------
        const filesDir = path.join(AGENT_WORKSPACE_DIR, 'files')
        fs.mkdirSync(filesDir, { recursive: true })
        const userFile = path.join(filesDir, 'keep-me.txt')
        fs.writeFileSync(userFile, 'user content')
        const staleBackup = path.join(filesDir, 'orchestrator-backup-2000-01-01-00-00-00.tar.gz')
        fs.writeFileSync(staleBackup, 'stale')
        const legacyWhatsAppDir = path.join(PRIVATE_STATE_DIR, 'whatsapp-web')
        const baileysWhatsAppDir = path.join(PRIVATE_STATE_DIR, 'whatsapp-baileys')
        fs.mkdirSync(legacyWhatsAppDir, { recursive: true })
        fs.mkdirSync(baileysWhatsAppDir, { recursive: true })
        fs.writeFileSync(path.join(legacyWhatsAppDir, 'session.json'), 'legacy-whatsapp-secret')
        fs.writeFileSync(path.join(baileysWhatsAppDir, 'creds.json'), 'baileys-whatsapp-secret')

        const backup = await executeCreateBackup()
        assert.strictEqual(backup.success, true, `create_backup should succeed: ${backup.error ?? ''}`)
        const backupData = backup.data as { path: string; filename: string; size: string }
        assert.ok(fs.existsSync(backupData.path), 'backup file exists on disk')
        assert.ok(backupData.path.startsWith(filesDir), 'backup landed in the Library files/ dir')
        assert.ok(fs.statSync(backupData.path).size > 0, 'backup is non-empty')
        assert.ok(!fs.existsSync(staleBackup), 'previous backup was pruned')
        assert.ok(fs.existsSync(userFile), 'unrelated user file was NOT touched')
        assert.ok(/^orchestrator-backup-.*\.tar\.gz$/.test(backupData.filename), 'backup filename matches the pattern')
        const backupEntries = await listTarGzEntries(backupData.path)
        assert.ok(!backupEntries.some(entry => entry.includes('private/whatsapp-web/')), 'legacy WhatsApp session is excluded from backup')
        assert.ok(!backupEntries.some(entry => entry.includes('private/whatsapp-baileys/')), 'Baileys WhatsApp session is excluded from backup')
        console.log(`  create_backup: ${backupData.filename} (${backupData.size}), stale pruned, user file kept`)

        // --- wiring ----------------------------------------------------------
        assert.ok(getTool('create_backup'), 'create_backup is registered')
        assert.ok(getTool('host_status'), 'host_status is registered')
        assert.strictEqual(createBackupTool.id, 'create_backup')
        assert.strictEqual(hostStatusTool.id, 'host_status')

        assert.ok(ALL_SUBSYSTEM_IDS.includes('app_guide'), 'app_guide is a subsystem id')
        assert.ok(ALL_CAPABILITY_IDS.includes('app_guide'), 'app_guide is a valid ActivateIntegrationTools id')
        assert.strictEqual(subsystemForGatedTool('host_status'), 'app_guide', 'host_status maps to app_guide')
        const doctrine = getSubsystemManifest('app_guide')?.doctrine ?? ''
        assert.ok(doctrine.length > 500, 'app_guide doctrine is substantial')
        assert.ok(/factory reset/i.test(doctrine), 'doctrine covers factory reset')
        assert.ok(/create_backup/.test(doctrine), 'doctrine mentions the create_backup tool')
        assert.ok(/WhatsApp.*Baileys/i.test(doctrine), 'doctrine covers the default WhatsApp Baileys provider')
        assert.ok(/WHATSAPP_PROVIDER=disabled/i.test(doctrine), 'doctrine covers the WhatsApp provider kill switch')
        assert.ok(/resumable/i.test(doctrine), 'doctrine covers stored Baileys sessions as resumable')
        assert.ok(/serialized and lightly paced/i.test(doctrine), 'doctrine covers paced WhatsApp operational calls')

        // Gating: host_status hidden until app_guide is activated; create_backup always present.
        const candidates = getToolsForAgent(['create_backup', 'host_status'])
        const before = filterIntegrationToolExposure(candidates, { conversationId: 'smoke-conv', origin: undefined })
        assert.ok(before.some(t => t.id === 'create_backup'), 'create_backup exposed without activation')
        assert.ok(!before.some(t => t.id === 'host_status'), 'host_status hidden without activation')
        activateIntegrations('smoke-conv', ['app_guide'])
        const after = filterIntegrationToolExposure(candidates, { conversationId: 'smoke-conv', origin: undefined })
        assert.ok(after.some(t => t.id === 'host_status'), 'host_status exposed after activating app_guide')
        console.log('  wiring: registered, gated correctly, doctrine present')

        console.log('\n✓ smoke-app-guide passed')
    } finally {
        fs.rmSync(stateDir, { recursive: true, force: true })
    }
}

main().catch((err) => {
    console.error('\n✗ smoke-app-guide failed')
    console.error(err)
    process.exit(1)
})

function listTarGzEntries(archivePath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const names: string[] = []
        const extractor = tarExtract()
        extractor.on('entry', (header, stream, next) => {
            names.push(header.name)
            stream.on('end', next)
            stream.resume()
        })
        extractor.on('finish', () => resolve(names))
        extractor.on('error', reject)

        const gunzip = zlib.createGunzip()
        gunzip.on('error', reject)
        Readable.from(fs.readFileSync(archivePath)).pipe(gunzip).pipe(extractor)
    })
}
