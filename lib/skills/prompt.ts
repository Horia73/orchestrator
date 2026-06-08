import { listSkills } from "./registry"

const MAX_PROMPT_SKILLS = 40
const MAX_DESCRIPTION_LENGTH = 220

export function buildSkillsIndex(): string {
  const skills = listSkills()
  if (!skills.length) return ""

  const rows = skills.slice(0, MAX_PROMPT_SKILLS).map((skill) => {
    const description = truncate(skill.description, MAX_DESCRIPTION_LENGTH)
    return `- ${skill.id} (${skill.name}) [${skill.scope}]: ${description}`
  })

  const overflow =
    skills.length > MAX_PROMPT_SKILLS
      ? `\n- ... ${skills.length - MAX_PROMPT_SKILLS} more installed skills omitted from prompt; use SkillSearch for full discovery.`
      : ""

  return `
<skills_index>
Installed workflow skills are available lazily. This list is an index only; do not assume the full instructions are loaded.
Use SkillSearch to find a matching skill, ActivateSkill to load SKILL.md, and ReadSkillFile for referenced guides/scripts/assets. Prefer worker for substantial skill-backed deliverables; orchestrator may use skills directly for small bounded tasks.
${rows.join("\n")}${overflow}
</skills_index>
`.trim()
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 3)}...`
}
