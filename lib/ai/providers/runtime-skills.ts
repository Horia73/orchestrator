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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
