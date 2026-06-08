import fs from 'fs'
import os from 'os'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'

export type CliSkillProvider = 'codex' | 'claude-code'

export interface RuntimeSkill {
    name: string
    description?: string
    path?: string
    scope?: string
}

const MAX_RENDERED_SKILLS = 80
const MAX_DESCRIPTION_CHARS = 220

export function appendRuntimeSkillsToSystemPrompt(
    systemPrompt: string | undefined,
    provider: CliSkillProvider,
    skills: RuntimeSkill[],
): string | undefined {
    const section = buildRuntimeSkillsSection(provider, skills)
    if (!section) return systemPrompt
    const trimmed = systemPrompt?.trim()
    return trimmed ? `${trimmed}\n\n${section}` : section
}

export function appendRuntimeSkillsToUserPrompt(
    prompt: string,
    provider: CliSkillProvider,
    skills: RuntimeSkill[],
): string {
    const section = buildRuntimeSkillsSection(provider, skills)
    if (!section) return prompt
    return `${section}\n\n<user_task>\n${prompt}\n</user_task>`
}

export function buildRuntimeSkillsSection(provider: CliSkillProvider, skills: RuntimeSkill[]): string {
    const normalized = dedupeSkills(skills)
    if (normalized.length === 0) return ''

    const invocationPrefix = provider === 'codex' ? '$' : '/'
    const providerLabel = provider === 'codex' ? 'Codex' : 'Claude Code'
    const visible = normalized.slice(0, MAX_RENDERED_SKILLS)
    const omitted = normalized.length - visible.length
    const items = visible.map(skill => {
        const description = truncateOneLine(skill.description ?? '', MAX_DESCRIPTION_CHARS)
        const scope = skill.scope ? ` [${skill.scope}]` : ''
        return `- ${invocationPrefix}${skill.name}${scope}${description ? `: ${description}` : ''}`
    })
    if (omitted > 0) items.push(`- ... ${omitted} more skills omitted from this prompt.`)

    return [
        '<runtime_skills>',
        `${providerLabel} skills visible to this runtime are listed below. Skills are reusable local workflows, not ordinary tools.`,
        `When the current task clearly matches a listed skill's name or description, use that skill before doing the specialized work. For direct invocation use \`${invocationPrefix}<skill-name>\`; otherwise rely on the provider's skill matching and read/follow the skill instructions once activated.`,
        'Do not claim a relevant skill is unavailable if it is listed here. If a task needs a skill that is not listed, report the missing capability instead of guessing its workflow.',
        ...items,
        '</runtime_skills>',
    ].join('\n')
}

export function selectExplicitlyRequestedSkills(prompt: string, skills: RuntimeSkill[]): RuntimeSkill[] {
    const out: RuntimeSkill[] = []
    for (const skill of dedupeSkills(skills)) {
        if (!skill.path) continue
        if (isSkillExplicitlyRequested(prompt, skill.name)) out.push(skill)
        if (out.length >= 4) break
    }
    return out
}

export function discoverClaudeCodeSkills(cwd = activeRuntimePaths().agentWorkspaceDir): RuntimeSkill[] {
    const roots = claudeSkillRoots(cwd)
    const skills: RuntimeSkill[] = []
    for (const root of roots) {
        for (const skillPath of skillMarkdownFiles(root.path)) {
            const skill = readSkillMetadata(skillPath, root.scope)
            if (skill) skills.push(skill)
        }
    }
    return dedupeSkills(skills)
}

function claudeSkillRoots(cwd: string): Array<{ path: string; scope: string }> {
    const roots: Array<{ path: string; scope: string }> = [
        { path: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
    ]

    for (const dir of parentDirs(cwd)) {
        roots.push({ path: path.join(dir, '.claude', 'skills'), scope: 'project' })
    }

    return roots
}

function parentDirs(start: string): string[] {
    const out: string[] = []
    let current = path.resolve(start || process.cwd())
    for (;;) {
        out.push(current)
        if (pathExists(path.join(current, '.git'))) break
        const next = path.dirname(current)
        if (next === current) break
        current = next
    }
    return out
}

function skillMarkdownFiles(root: string): string[] {
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true })
        const out: string[] = []
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const skillPath = path.join(root, entry.name, 'SKILL.md')
            if (fileExists(skillPath)) out.push(skillPath)
        }
        return out
    } catch {
        return []
    }
}

function readSkillMetadata(skillPath: string, scope: string): RuntimeSkill | null {
    try {
        const raw = fs.readFileSync(skillPath, 'utf-8').slice(0, 16_000)
        const frontmatter = parseFrontmatter(raw)
        const fallbackName = path.basename(path.dirname(skillPath))
        const name = cleanSkillName(frontmatter.name) || fallbackName
        if (!name) return null
        return {
            name,
            description: truncateOneLine(frontmatter.description ?? '', MAX_DESCRIPTION_CHARS),
            path: skillPath,
            scope,
        }
    } catch {
        return null
    }
}

function parseFrontmatter(raw: string): Record<string, string> {
    if (!raw.startsWith('---')) return {}
    const end = raw.indexOf('\n---', 3)
    if (end < 0) return {}
    const body = raw.slice(3, end)
    const out: Record<string, string> = {}
    for (const line of body.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
        if (!match) continue
        const key = match[1]
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (value && value !== '|' && value !== '>') out[key] = value
    }
    return out
}

function dedupeSkills(skills: RuntimeSkill[]): RuntimeSkill[] {
    const seen = new Set<string>()
    const out: RuntimeSkill[] = []
    for (const skill of skills) {
        const name = cleanSkillName(skill.name)
        if (!name) continue
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
            ...skill,
            name,
            description: truncateOneLine(skill.description ?? '', MAX_DESCRIPTION_CHARS),
        })
    }
    return out
}

function isSkillExplicitlyRequested(prompt: string, name: string): boolean {
    const escaped = escapeRegExp(name)
    const marker = new RegExp(`(^|[\\s"'(\`])[$/]${escaped}(?=$|[\\s"').,;:!?\\\`])`, 'i')
    if (marker.test(prompt)) return true

    const namedSkill = new RegExp(`\\bskill(?:ul|ului)?\\s+[$/]?${escaped}\\b`, 'i')
    return namedSkill.test(prompt)
}

function cleanSkillName(name: string | undefined): string {
    return (name ?? '').trim().replace(/^[$/]+/, '')
}

function truncateOneLine(value: string, maxChars: number): string {
    const oneLine = value.replace(/\s+/g, ' ').trim()
    if (oneLine.length <= maxChars) return oneLine
    return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trim()}...`
}

function fileExists(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile()
    } catch {
        return false
    }
}

function pathExists(filePath: string): boolean {
    try {
        fs.statSync(filePath)
        return true
    } catch {
        return false
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
