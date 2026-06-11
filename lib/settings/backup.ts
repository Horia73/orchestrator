import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import zlib from 'zlib'

import archiver from 'archiver'
import { extract as tarExtract } from 'tar-stream'

import { getDatabaseForProfile } from '@/lib/db'
import { getControlDb, listProfiles } from '@/lib/profiles/store'
import {
    ORCHESTRATOR_STATE_DIR,
    PROJECT_DIR,
    runtimePathsForProfile,
} from '@/lib/runtime-paths'
import { PENDING_RESTORE_DIR } from '@/lib/settings/backup-boot'

export const BACKUP_FORMAT = 'orchestrator-backup'
export const BACKUP_FORMAT_VERSION = 1

const STAGING_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, '.restore-staging')

/**
 * `private/` subdirectories deliberately left out of backups: live browser
 * profiles (WhatsApp Web, the browser agent) are not crash-consistent while the
 * app runs and are tied to the browser build, and the codex CLI home / map
 * tiles are large, regenerable caches. Re-link those sessions after a restore.
 */
const PRIVATE_EXCLUDES = new Set([
    'whatsapp-web',
    'browser-agent',
    'codex-runtime-home',
    'maps-static-cache',
])

const EXCLUDED_FOR_MANIFEST = [
    'private/whatsapp-web',
    'private/browser-agent',
    'private/codex-runtime-home',
    'private/maps-static-cache',
    'profiles/*/private/whatsapp-web',
    'profiles/*/private/browser-agent',
    'profiles/*/private/codex-runtime-home',
    'profiles/*/private/maps-static-cache',
    'index',
    'cache',
]

interface FileEntry {
    abs: string
    /** POSIX-style path relative to ORCHESTRATOR_STATE_DIR. */
    rel: string
    mode: number
    bytes: number
}

interface DbCopy {
    abs: string
    rel: string
    bytes: number
}

interface ManifestEntry {
    path: string
    bytes: number
    sha256: string
}

interface BackupManifest {
    format: string
    formatVersion: number
    createdAt: string
    appVersion: string
    excluded: string[]
    restore: 'overlay'
    entries: ManifestEntry[]
}

export interface BackupArchive {
    archivePath: string
    fileName: string
    bytes: number
    /** Remove the temp working directory once the archive has been streamed. */
    cleanup: () => void
}

export interface RestoreResult {
    restoredFiles: number
    dbStagedForRestart: boolean
    restartRequired: boolean
    appVersion: string | null
    createdAt: string | null
}

/**
 * Build a `.tar.gz` of the clean, portable application state: a crash-consistent
 * copy of the SQLite database plus the workspace, uploads, and the small
 * connected-account credential/config files under `private/`. The archive is a
 * standard tarball — recoverable with `tar -xzf` even if the app won't boot.
 */
export async function createBackupArchive(): Promise<BackupArchive> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backup-'))
    const dbCopyDir = path.join(workDir, 'db')
    const archivePath = path.join(workDir, 'archive.tar.gz')

    try {
        // 1. Crash-consistent database copies. VACUUM INTO checkpoints each WAL
        //    into a standalone file, safe to take while the app is running.
        fs.mkdirSync(dbCopyDir, { recursive: true })
        const dbCopies = copyDatabasesForBackup(dbCopyDir)

        // 2. Collect the file entries from the safe state set.
        const fileEntries = collectProfileFileEntries()

        // 3. Manifest with per-file checksums (database included first).
        const entries: ManifestEntry[] = []
        for (const copy of dbCopies) {
            entries.push({ path: `state/${copy.rel}`, bytes: copy.bytes, sha256: sha256File(copy.abs) })
        }
        for (const entry of fileEntries) {
            entries.push({ path: `state/${entry.rel}`, bytes: entry.bytes, sha256: sha256File(entry.abs) })
        }

        const manifest: BackupManifest = {
            format: BACKUP_FORMAT,
            formatVersion: BACKUP_FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            appVersion: readAppVersion(),
            excluded: EXCLUDED_FOR_MANIFEST,
            restore: 'overlay',
            entries,
        }

        // 4. Pack the tarball.
        await new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(archivePath)
            const archive = archiver('tar', { gzip: true, gzipOptions: { level: 6 } })
            let settled = false
            const fail = (err: unknown) => {
                if (settled) return
                settled = true
                reject(err instanceof Error ? err : new Error(String(err)))
            }
            output.on('close', () => {
                if (settled) return
                settled = true
                resolve()
            })
            output.on('error', fail)
            archive.on('error', fail)
            archive.on('warning', (warning) => {
                // Missing-file warnings are non-fatal (a file may vanish between
                // the walk and packing); anything else aborts the backup.
                if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') fail(warning)
            })
            archive.pipe(output)
            archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' })
            for (const copy of dbCopies) {
                archive.file(copy.abs, { name: `state/${copy.rel}` })
            }
            for (const entry of fileEntries) {
                archive.file(entry.abs, { name: `state/${entry.rel}`, mode: entry.mode })
            }
            void archive.finalize()
        })

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        return {
            archivePath,
            fileName: `orchestrator-backup-${stamp}.tar.gz`,
            bytes: fs.statSync(archivePath).size,
            cleanup: () => {
                try {
                    fs.rmSync(workDir, { recursive: true, force: true })
                } catch {
                    // Temp dir cleanup is best-effort.
                }
            },
        }
    } catch (err) {
        try {
            fs.rmSync(workDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup failure on the error path.
        }
        throw err
    }
}

/**
 * Restore a backup produced by {@link createBackupArchive}. File state
 * (workspace, uploads, credentials) is overlaid onto the live tree immediately
 * — existing files absent from the backup are kept, so a restore never deletes
 * the WhatsApp/browser session that this format intentionally excludes. The
 * database cannot be hot-swapped under the open connection, so it is staged and
 * applied on the next restart (see {@link ./backup-boot}).
 */
export async function applyBackupRestore(input: Buffer | Uint8Array): Promise<RestoreResult> {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)

    fs.rmSync(STAGING_DIR, { recursive: true, force: true })
    fs.mkdirSync(STAGING_DIR, { recursive: true })

    try {
        await extractTarGz(buffer, STAGING_DIR)

        const manifestPath = path.join(STAGING_DIR, 'manifest.json')
        if (!fs.existsSync(manifestPath)) {
            throw new Error('Not an Orchestrator backup: manifest.json is missing.')
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<BackupManifest>
        if (manifest.format !== BACKUP_FORMAT) {
            throw new Error('Unrecognized backup format.')
        }
        if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION) {
            throw new Error(
                `Unsupported backup version (${String(manifest.formatVersion)}). Update Orchestrator before restoring.`
            )
        }
        const entries = Array.isArray(manifest.entries) ? manifest.entries : []
        if (entries.length === 0) {
            throw new Error('Backup contains no entries.')
        }

        // Verify every entry is present and intact BEFORE touching live state, so
        // a corrupt archive aborts cleanly without a partial restore.
        for (const entry of entries) {
            if (typeof entry?.path !== 'string') throw new Error('Malformed backup manifest entry.')
            const staged = path.join(STAGING_DIR, entry.path)
            if (!withinDir(STAGING_DIR, staged)) throw new Error('Backup entry escapes the archive root.')
            if (!fs.existsSync(staged)) throw new Error(`Backup is missing a file: ${entry.path}`)
            if (typeof entry.sha256 === 'string' && sha256File(staged) !== entry.sha256) {
                throw new Error(`Checksum mismatch for ${entry.path}; the backup is corrupt.`)
            }
        }

        // Stage databases for the next boot.
        let dbStaged = false
        const stagedDbEntries = entries.filter((entry) => isDatabaseEntryPath(entry.path))
        if (stagedDbEntries.length > 0) {
            fs.rmSync(PENDING_RESTORE_DIR, { recursive: true, force: true })
            fs.mkdirSync(PENDING_RESTORE_DIR, { recursive: true })
            for (const entry of stagedDbEntries) {
                const rel = entry.path.slice('state/'.length)
                const target = path.join(PENDING_RESTORE_DIR, rel)
                fs.mkdirSync(path.dirname(target), { recursive: true })
                fs.copyFileSync(path.join(STAGING_DIR, entry.path), target)
            }
            fs.writeFileSync(path.join(PENDING_RESTORE_DIR, 'APPLY'), new Date().toISOString())
            dbStaged = true
        }

        // Overlay the remaining files onto the live tree.
        let restoredFiles = 0
        for (const entry of entries) {
            if (isDatabaseEntryPath(entry.path)) continue
            if (!entry.path.startsWith('state/')) continue
            const rel = entry.path.slice('state/'.length)
            if (rel.length === 0) continue
            const target = path.join(ORCHESTRATOR_STATE_DIR, rel)
            if (!withinDir(ORCHESTRATOR_STATE_DIR, target)) continue
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(path.join(STAGING_DIR, entry.path), target)
            if (rel.startsWith('private/')) {
                try {
                    fs.chmodSync(target, 0o600)
                } catch {
                    // Some mounted filesystems ignore chmod.
                }
            }
            restoredFiles++
        }
        // Keep the credentials directory locked down.
        for (const profile of listProfiles({ includeDisabled: true })) {
            try {
                fs.chmodSync(runtimePathsForProfile(profile.id).privateStateDir, 0o700)
            } catch {
                // Best-effort.
            }
        }

        return {
            restoredFiles,
            dbStagedForRestart: dbStaged,
            restartRequired: dbStaged,
            appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null,
            createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
        }
    } finally {
        fs.rmSync(STAGING_DIR, { recursive: true, force: true })
    }
}

function copyDatabasesForBackup(dbCopyDir: string): DbCopy[] {
    const copies: DbCopy[] = []

    vacuumDatabaseTo(getControlDb(), path.join(dbCopyDir, 'control.db'))
    copies.push({
        abs: path.join(dbCopyDir, 'control.db'),
        rel: 'control.db',
        bytes: fs.statSync(path.join(dbCopyDir, 'control.db')).size,
    })

    for (const profile of listProfiles({ includeDisabled: true })) {
        const profilePaths = runtimePathsForProfile(profile.id)
        const rel = stateRelative(path.join(profilePaths.stateDir, 'data.db'))
        const target = path.join(dbCopyDir, rel)
        vacuumDatabaseTo(getDatabaseForProfile(profile.id), target)
        copies.push({
            abs: target,
            rel,
            bytes: fs.statSync(target).size,
        })
    }

    return copies
}

function vacuumDatabaseTo(database: { exec: (sql: string) => unknown }, target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
}

function collectProfileFileEntries(): FileEntry[] {
    const entries: FileEntry[] = []
    const seen = new Set<string>()
    for (const profile of listProfiles({ includeDisabled: true })) {
        const paths = runtimePathsForProfile(profile.id)
        for (const entry of [
            ...walkDir(paths.workspaceDir),
            ...walkDir(paths.uploadsDir),
            ...walkDir(paths.privateStateDir, PRIVATE_EXCLUDES),
        ]) {
            if (seen.has(entry.abs)) continue
            seen.add(entry.abs)
            entries.push(entry)
        }
    }
    return entries
}

function walkDir(root: string, excludeTop?: Set<string>): FileEntry[] {
    const out: FileEntry[] = []
    if (!fs.existsSync(root)) return out

    const stack: string[] = [root]
    while (stack.length > 0) {
        const dir = stack.pop() as string
        let names: string[]
        try {
            names = fs.readdirSync(dir)
        } catch {
            continue
        }
        for (const name of names) {
            if (name === '.DS_Store') continue
            if (dir === root && excludeTop?.has(name)) continue
            const abs = path.join(dir, name)
            let stat: fs.Stats
            try {
                stat = fs.lstatSync(abs)
            } catch {
                continue
            }
            // Never follow or serialize symlinks — avoids escaping the state tree.
            if (stat.isSymbolicLink()) continue
            if (stat.isDirectory()) {
                stack.push(abs)
                continue
            }
            if (!stat.isFile()) continue
            out.push({
                abs,
                rel: stateRelative(abs),
                mode: stat.mode & 0o777,
                bytes: stat.size,
            })
        }
    }
    return out
}

function stateRelative(abs: string): string {
    return path.relative(ORCHESTRATOR_STATE_DIR, abs).split(path.sep).join('/')
}

function isDatabaseEntryPath(entryPath: string): boolean {
    if (!entryPath.startsWith('state/')) return false
    const rel = entryPath.slice('state/'.length)
    return rel === 'data.db' || rel === 'control.db' || /^profiles\/[^/]+\/data\.db$/.test(rel)
}

function extractTarGz(buffer: Buffer, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const extractor = tarExtract()

        extractor.on('entry', (header, stream, next) => {
            try {
                const target = path.join(destDir, header.name)
                if (!withinDir(destDir, target)) {
                    stream.resume()
                    next(new Error('Path traversal detected in archive.'))
                    return
                }
                if (header.type === 'directory') {
                    fs.mkdirSync(target, { recursive: true })
                    stream.on('end', next)
                    stream.resume()
                    return
                }
                if (header.type !== 'file') {
                    // Skip symlinks/hardlinks/etc. — files and directories only.
                    stream.on('end', next)
                    stream.resume()
                    return
                }
                fs.mkdirSync(path.dirname(target), { recursive: true })
                const writeStream = fs.createWriteStream(target)
                writeStream.on('error', next)
                writeStream.on('finish', next)
                stream.pipe(writeStream)
            } catch (err) {
                stream.resume()
                next(err instanceof Error ? err : new Error(String(err)))
            }
        })

        extractor.on('finish', () => resolve())
        extractor.on('error', reject)

        const gunzip = zlib.createGunzip()
        gunzip.on('error', reject)
        Readable.from(buffer).pipe(gunzip).pipe(extractor)
    })
}

function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function withinDir(parent: string, child: string): boolean {
    const rel = path.relative(parent, child)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function readAppVersion(): string {
    try {
        const raw = fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')
        const version = (JSON.parse(raw) as { version?: unknown }).version
        return typeof version === 'string' ? version : 'unknown'
    } catch {
        return 'unknown'
    }
}
