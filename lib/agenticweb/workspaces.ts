import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

/**
 * Workspace-uri izolate pentru site-urile AgenticWeb: câte o clonă git per
 * site, în afara oricărui director al Orchestrator-ului, ca agentul editor
 * (claude/codex headless cu cwd aici) să nu vadă decât site-ul lui.
 *
 *   <bază>/<slug>/repo   — clona repo-ului site-ului
 *
 * Baza e configurabilă (`AGENTICWEB_WORKSPACES_DIR`); implicit
 * `~/agenticweb-lab`. Pregătirea e idempotentă: clonează doar dacă lipsește,
 * apoi (pentru mode=edit) taie branch-ul de lucru din HEAD-ul curent.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,120}$/

export interface WorkspaceResult {
    dir: string
    cloned: boolean
    branch?: string
}

export function workspacesBaseDir(): string {
    return process.env.AGENTICWEB_WORKSPACES_DIR?.trim() || join(homedir(), 'agenticweb-lab')
}

export async function prepareWorkspace(options: {
    siteSlug: string
    repoUrl?: string
    branch?: string
}): Promise<WorkspaceResult> {
    const { siteSlug, repoUrl, branch } = options
    if (!SLUG_RE.test(siteSlug)) throw new Error(`siteSlug invalid: ${siteSlug}`)
    if (branch && !BRANCH_RE.test(branch)) throw new Error(`branch invalid: ${branch}`)

    const siteDir = join(workspacesBaseDir(), siteSlug)
    const repoDir = join(siteDir, 'repo')
    mkdirSync(siteDir, { recursive: true })

    let cloned = false
    if (!existsSync(join(repoDir, '.git'))) {
        if (!repoUrl) {
            // Fără repo: director gol de lucru (mode=ask, teste de instrucțiuni).
            mkdirSync(repoDir, { recursive: true })
        } else {
            assertGitUrl(repoUrl)
            await git(siteDir, ['clone', repoUrl, 'repo'])
            cloned = true
        }
    }

    if (branch && existsSync(join(repoDir, '.git'))) {
        // Branch de lucru din HEAD-ul curent; -B e idempotent la re-rulare.
        await git(repoDir, ['checkout', '-B', branch])
    }

    return { dir: repoDir, cloned, branch }
}

function assertGitUrl(url: string) {
    // Doar https către forge-uri cunoscute — nu executăm URL-uri arbitrare
    // venite peste rețea, chiar și cu secret valid.
    const ok = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(\.git)?$/.test(url)
    if (!ok) throw new Error(`repoUrl neacceptat: ${url}`)
}

async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
}
