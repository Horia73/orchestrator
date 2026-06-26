import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import {
  findSkill,
  listSkillFiles,
  publicSkill,
  readSkillFile,
  searchSkills,
} from "@/lib/skills/registry"

export const skillSearchTool: ToolDef = {
  id: "SkillSearch",
  name: "SkillSearch",
  description:
    "Search installed Orchestrator workflow skills by name and description. Use before specialized workflows such as PPTX decks so full skill instructions can be loaded only when relevant. Do not guess or shell-read provider-native skill paths; Orchestrator resolves skill roots for you.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search query, e.g. 'pptx', 'presentation deck', or the skill name. Omit to list installed skills.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of skills to return. Defaults to 20.",
      },
    },
  },
  tags: ["read", "skills"],
}

export const activateSkillTool: ToolDef = {
  id: "ActivateSkill",
  name: "ActivateSkill",
  description:
    "Load an installed Orchestrator workflow skill's SKILL.md instructions and return its skill_root. Call this before following a skill-backed workflow instead of reading CODEX_HOME/.codex/skills, ~/.codex/skills, or ~/.claude/skills.",
  input_schema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Skill id or name, e.g. 'pptx'.",
      },
      include_files: {
        type: "array",
        description:
          "Optional additional skill-relative files to read immediately, such as 'references/editing.md'.",
        items: { type: "string" },
      },
      max_chars_per_file: {
        type: "integer",
        description:
          "Maximum characters returned for SKILL.md and each included file. Defaults to 60000, capped at 120000.",
      },
    },
    required: ["skill"],
  },
  tags: ["read", "skills"],
}

export const readSkillFileTool: ToolDef = {
  id: "ReadSkillFile",
  name: "ReadSkillFile",
  description:
    "Read a specific file inside an activated Orchestrator skill, resolved relative to skill_root. Use for referenced guides, scripts, schemas, and assets; path must be skill-relative, never an inferred provider-native absolute path.",
  input_schema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Skill id or name, e.g. 'pptx'.",
      },
      path: {
        type: "string",
        description:
          "Skill-relative file path, e.g. 'references/editing.md' or 'scripts/thumbnail.py'.",
      },
      max_chars: {
        type: "integer",
        description:
          "Maximum characters returned. Defaults to 60000, capped at 120000.",
      },
    },
    required: ["skill", "path"],
  },
  tags: ["read", "skills"],
}

export const skillTools: ToolDef[] = [
  skillSearchTool,
  activateSkillTool,
  readSkillFileTool,
]

export async function executeSkillSearch(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query : ""
  const limit = typeof args.limit === "number" ? args.limit : 20
  const skills = searchSkills(query, limit).map(publicSkill)
  return {
    success: true,
    data: {
      skills,
      count: skills.length,
      guidance:
        "Call ActivateSkill with the matching skill id before relying on its workflow instructions.",
    },
  }
}

export async function executeActivateSkill(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const skill = requireSkill(args.skill)
  const maxChars =
    typeof args.max_chars_per_file === "number" ? args.max_chars_per_file : undefined
  const skillFile = readSkillFile(skill, "SKILL.md", maxChars)
  const includeFiles = arrayOfStrings(args.include_files)
  const files = includeFiles.map((file) => readSkillFile(skill, file, maxChars))

  return {
    success: true,
    data: {
      skill: publicSkill(skill),
      skill_root: skill.root,
      skill_md: skillFile,
      files,
      file_index: listSkillFiles(skill),
      guidance: [
        "Follow SKILL.md as the authority for this workflow.",
        "Resolve referenced files relative to skill_root.",
        "Run helper scripts by absolute path or from skill_root; do not retype large helper code.",
        "Use ReadSkillFile for additional guides, scripts, schemas, or templates as needed.",
      ],
    },
  }
}

export async function executeReadSkillFile(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const skill = requireSkill(args.skill)
  const filePath = stringArg(args.path, "path")
  const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined
  return {
    success: true,
    data: {
      skill: publicSkill(skill),
      file: readSkillFile(skill, filePath, maxChars),
    },
  }
}

function requireSkill(value: unknown) {
  const name = stringArg(value, "skill")
  const skill = findSkill(name)
  if (!skill) {
    throw new Error(`Skill not found: ${name}`)
  }
  return skill
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`)
  }
  return value.trim()
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}
