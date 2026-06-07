import fs from 'fs'
import path from 'path'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { createBackupArchive } from '@/lib/settings/backup'

// ---------------------------------------------------------------------------
// create_backup — produce the same portable backup the user can download from
// Settings → Updates → Danger zone, but land it where the agent can reach it.
//
// The HTTP route /api/settings/backup streams the archive straight to the
// browser for download; that path is unreachable from a tool call. This tool
// calls the SAME createBackupArchive() in-process and copies the .tar.gz into
// the workspace `files/` directory, which surfaces in the user-facing Library.
// From there the agent can hand it off with any file-capable tool the user
// asked for (attach to an email, send over WhatsApp, upload to Drive, …) — the
// delivery channel is NOT this tool's job, it just creates + saves the file.
//
// SENSITIVE: a backup is a complete credential dump — the full SQLite DB, the
// connected-account OAuth tokens under private/, and workspace `.env.local`
// (provider API keys). The description makes the model treat sharing it with
// the same care as the secrets themselves.
// ---------------------------------------------------------------------------

function libraryFilesDir(): string {
    return path.join(activeRuntimePaths().agentWorkspaceDir, 'files')
}
// Only ever keep the newest backup in the Library: these archives are large
// credential dumps, and an un-pruned copy under files/ also gets swept into the
// NEXT backup (files/ is part of the backed-up workspace), so leaving them
// around bloats every subsequent backup. Matches the timestamped fileName from
// createBackupArchive() — never touches the user's own files.
const BACKUP_FILE_PATTERN = /^orchestrator-backup-.*\.tar\.gz$/

export const createBackupTool: ToolDef = {
    id: 'create_backup',
    name: 'create_backup',
    description: [
        'Create a full backup of this Orchestrator — the exact archive the user gets from Settings → Updates → Danger zone → Backup.',
        'Produces a portable `.tar.gz` (crash-consistent copy of the database + workspace + uploads + the small connected-account credential files) and saves it into the user-facing Library (the workspace `files/` folder), replacing any previous backup there.',
        'Use this when the user asks you to back up / export the app, or as the first step before they want the backup delivered somewhere.',
        'This tool only CREATES and SAVES the file and returns its local `path`; it does NOT send it anywhere. If the user wanted it emailed / sent over WhatsApp / uploaded to Drive, attach the returned path with the relevant integration tool afterwards.',
        'SENSITIVE: the archive contains the complete database, OAuth tokens for every connected account, and provider API keys. Treat sharing it as sharing all of those secrets — confirm the destination with the user before sending it off-device.',
        'You can create a backup but you CANNOT restore one or factory-reset the app — those stay user-only from Settings.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['write', 'backup', 'sensitive'],
}

function humanSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${Math.round(kb)} KB`
    const mb = kb / 1024
    if (mb < 1024) return `${mb.toFixed(1)} MB`
    return `${(mb / 1024).toFixed(2)} GB`
}

export async function executeCreateBackup(): Promise<ToolResult> {
    let archive: Awaited<ReturnType<typeof createBackupArchive>> | null = null
    try {
        // Build the archive first (into a temp dir). Doing this before pruning
        // means a failure never destroys the user's existing Library backup.
        archive = await createBackupArchive()

        const targetDir = libraryFilesDir()
        fs.mkdirSync(targetDir, { recursive: true })

        // Drop any earlier backup copy from the Library before placing the new one.
        for (const name of safeReaddir(targetDir)) {
            if (BACKUP_FILE_PATTERN.test(name)) {
                try {
                    fs.rmSync(path.join(targetDir, name), { force: true })
                } catch {
                    // Best-effort cleanup; a leftover old backup is not fatal.
                }
            }
        }

        const destPath = path.join(targetDir, archive.fileName)
        fs.copyFileSync(archive.archivePath, destPath)
        const bytes = fs.statSync(destPath).size

        return {
            success: true,
            data: {
                path: destPath,
                filename: archive.fileName,
                size: humanSize(bytes),
                bytes,
                saved_to: 'Library (workspace files/ folder)',
                contains: 'Full database, workspace, uploads, and connected-account credentials (OAuth tokens + provider API keys).',
                sensitive: 'This archive is a complete credential dump. Confirm with the user before sending it anywhere off-device, then attach this path with the relevant tool (email/WhatsApp/Drive).',
                note: 'Any previous backup in the Library was replaced. Restore and factory reset remain user-only from Settings → Updates → Danger zone.',
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to create backup.',
        }
    } finally {
        archive?.cleanup()
    }
}

function safeReaddir(dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        return []
    }
}
