export type RuntimeSkillScope = "profile" | "global" | "bundled"

export interface RuntimeSkill {
  id: string
  name: string
  description: string
  license?: string
  root: string
  skillFile: string
  scope: RuntimeSkillScope
  source: string
}

export interface SkillFileRead {
  path: string
  absolutePath: string
  content: string
  truncated: boolean
  size: number
}

