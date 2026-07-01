import fs from "fs"
import path from "path"

import {
  ORCHESTRATOR_STATE_DIR,
  PROJECT_DIR,
  activeRuntimePaths,
} from "@/lib/runtime-paths"

import type {
  RuntimeSkill,
  RuntimeSkillScope,
  SkillFileRead,
  WritableSkillScope,
} from "./types"

const SKILL_FILE = "SKILL.md"
const DEFAULT_MAX_READ_CHARS = 60_000
const MAX_READ_CHARS = 120_000

interface SkillRoot {
  scope: RuntimeSkillScope
  source: string
  dir: string
}

interface WritableSkillRoot {
  scope: WritableSkillScope
  source: string
  dir: string
}

export interface CreateCustomSkillInput {
  scope: WritableSkillScope
  id?: string
  name: string
  description: string
}

export function skillRoots(): SkillRoot[] {
  const runtime = activeRuntimePaths()
  return [
    {
      scope: "profile",
      source: "active profile",
      dir: path.join(runtime.privateStateDir, "skills"),
    },
    {
      scope: "global",
      source: "orchestrator state",
      dir: path.join(ORCHESTRATOR_STATE_DIR, "skills"),
    },
    {
      scope: "bundled",
      source: "repository",
      dir: path.join(PROJECT_DIR, "skills"),
    },
  ]
}

export function listSkills(): RuntimeSkill[] {
  const byId = new Map<string, RuntimeSkill>()
  for (const root of skillRoots()) {
    for (const skill of scanSkillRoot(root)) {
      if (!byId.has(skill.id)) byId.set(skill.id, skill)
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function listSkillEntries(): RuntimeSkill[] {
  return skillRoots()
    .flatMap((root) => scanSkillRoot(root))
    .sort(
      (a, b) =>
        a.id.localeCompare(b.id) ||
        skillScopeRank(a.scope) - skillScopeRank(b.scope)
    )
}

export function searchSkills(query?: string, limit = 20): RuntimeSkill[] {
  const normalizedQuery = normalizeSearch(query)
  const skills = listSkills()
  const safeLimit = clampLimit(limit)
  if (!normalizedQuery) return skills.slice(0, safeLimit)

  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean)
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, safeLimit)
    .map((entry) => entry.skill)
}

export function findSkill(identifier: string): RuntimeSkill | null {
  const clean = identifier.trim().toLowerCase()
  if (!clean) return null
  return (
    listSkills().find(
      (skill) =>
        skill.id.toLowerCase() === clean ||
        skill.name.toLowerCase() === clean ||
        slugify(skill.name) === clean
    ) ?? null
  )
}

export function readSkillFile(
  skill: RuntimeSkill,
  relativePath = SKILL_FILE,
  maxChars = DEFAULT_MAX_READ_CHARS
): SkillFileRead {
  const resolved = resolveSkillPath(skill, relativePath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) {
    throw new Error(`${relativePath} is not a file.`)
  }
  const safeMax = clampReadChars(maxChars)
  const raw = fs.readFileSync(resolved, "utf8")
  const truncated = raw.length > safeMax
  return {
    path: path.relative(skill.root, resolved) || SKILL_FILE,
    absolutePath: resolved,
    content: truncated ? raw.slice(0, safeMax) : raw,
    truncated,
    size: stat.size,
  }
}

export function listSkillFiles(skill: RuntimeSkill, maxFiles = 120): string[] {
  const files: string[] = []
  const visit = (dir: string, depth: number) => {
    if (files.length >= maxFiles || depth > 4) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "__pycache__")
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        if (files.length >= maxFiles) return
        const absolute = path.join(dir, entry.name)
        const relative = path.relative(skill.root, absolute)
        if (entry.isDirectory()) {
          visit(absolute, depth + 1)
          return
        }
        if (entry.isFile()) files.push(relative)
      })
  }
  visit(skill.root, 0)
  return files
}

export function publicSkill(skill: RuntimeSkill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    license: skill.license ?? null,
    scope: skill.scope,
    source: skill.source,
  }
}

export function writableSkillRoots(): WritableSkillRoot[] {
  const runtime = activeRuntimePaths()
  return [
    {
      scope: "profile",
      source: "active profile",
      dir: path.join(runtime.privateStateDir, "skills"),
    },
    {
      scope: "global",
      source: "orchestrator state",
      dir: path.join(ORCHESTRATOR_STATE_DIR, "skills"),
    },
  ]
}

export function isWritableSkillScope(
  value: string
): value is WritableSkillScope {
  return value === "profile" || value === "global"
}

export function normalizeSkillId(value: string): string {
  const id = slugify(value)
  if (!id) throw new Error("Skill id must contain at least one letter or number.")
  if (id.length > 80) throw new Error("Skill id must be 80 characters or less.")
  return id
}

export function createCustomSkill(input: CreateCustomSkillInput): RuntimeSkill {
  const name = cleanSkillMetadataValue(input.name)
  if (!name) throw new Error("Skill name is required.")
  const description = cleanSkillMetadataValue(input.description)
  if (!description) throw new Error("Skill description is required.")
  const id = normalizeSkillId(input.id || name)
  const root = getWritableSkillRoot(input.scope)
  const skillDir = path.join(root.dir, id)
  const skillFile = path.join(skillDir, SKILL_FILE)
  if (
    fs.existsSync(skillFile) ||
    scanSkillRoot(root).some(
      (entry) => entry.id === id || path.basename(entry.root) === id
    )
  ) {
    throw new Error(`A ${input.scope} skill named "${id}" already exists.`)
  }
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(skillFile, customSkillTemplate(id, name, description), "utf8")
  return readCustomSkill(input.scope, id)
}

export function readCustomSkill(
  scope: WritableSkillScope,
  id: string
): RuntimeSkill {
  const skill = findCustomSkill(scope, id)
  if (!skill) {
    throw new Error(`Custom skill "${normalizeSkillId(id)}" was not found.`)
  }
  return skill
}

export function writeCustomSkillFile(
  scope: WritableSkillScope,
  id: string,
  content: string
): RuntimeSkill {
  const skill = readCustomSkill(scope, id)
  const parsed = parseSkillMetadata(content)
  const resolvedId = normalizeSkillId(parsed.id || parsed.name || skill.id)
  if (resolvedId !== skill.id) {
    throw new Error(
      `SKILL.md frontmatter resolves to "${resolvedId}", but this skill is "${skill.id}".`
    )
  }
  fs.writeFileSync(skill.skillFile, content, "utf8")
  return readCustomSkill(scope, skill.id)
}

export function deleteCustomSkill(
  scope: WritableSkillScope,
  id: string
): void {
  const skill = readCustomSkill(scope, id)
  fs.rmSync(skill.root, { recursive: true, force: true })
}

function scanSkillRoot(root: SkillRoot): RuntimeSkill[] {
  if (!fs.existsSync(root.dir)) return []
  return fs
    .readdirSync(root.dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => {
      const skillRoot = path.join(root.dir, entry.name)
      const skillFile = path.join(skillRoot, SKILL_FILE)
      if (!fs.existsSync(skillFile)) return []
      try {
        const content = fs.readFileSync(skillFile, "utf8")
        const metadata = parseSkillMetadata(content)
        const name = metadata.name || entry.name
        const id = slugify(metadata.id || name || entry.name)
        return [
          {
            id,
            name,
            description: metadata.description || "No description provided.",
            license: metadata.license,
            root: skillRoot,
            skillFile,
            scope: root.scope,
            source: root.source,
          },
        ]
      } catch {
        return []
      }
    })
}

function getWritableSkillRoot(scope: WritableSkillScope): WritableSkillRoot {
  const root = writableSkillRoots().find((candidate) => candidate.scope === scope)
  if (!root) throw new Error(`Unsupported skill scope "${scope}".`)
  return root
}

function findCustomSkill(
  scope: WritableSkillScope,
  id: string
): RuntimeSkill | null {
  const cleanId = normalizeSkillId(id)
  const root = getWritableSkillRoot(scope)
  return (
    scanSkillRoot(root).find(
      (entry) => entry.id === cleanId || path.basename(entry.root) === cleanId
    ) ?? null
  )
}

function skillScopeRank(scope: RuntimeSkillScope): number {
  if (scope === "profile") return 0
  if (scope === "global") return 1
  return 2
}

function cleanSkillMetadataValue(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function customSkillTemplate(
  id: string,
  name: string,
  description: string
): string {
  return `---
id: ${id}
name: ${name}
description: ${description}
---

# ${name}

Use this skill when ${description}

## Instructions

- Describe when the agent should use this skill.
- Add the workflow steps, constraints, validation commands, and deliverable expectations.
- Put reusable scripts, templates, or references next to this SKILL.md and link them here.
`
}

function parseSkillMetadata(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {}
  const end = content.indexOf("\n---", 3)
  if (end === -1) return {}
  const frontmatter = content.slice(3, end).trim()
  const metadata: Record<string, string> = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    metadata[match[1].trim()] = unquote(match[2].trim())
  }
  return metadata
}

function resolveSkillPath(skill: RuntimeSkill, relativePath: string): string {
  const cleanRelative = relativePath.trim() || SKILL_FILE
  if (path.isAbsolute(cleanRelative)) {
    throw new Error("Skill file path must be relative to skill_root.")
  }
  const root = path.resolve(skill.root)
  const target = path.resolve(root, cleanRelative)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Skill file path escapes skill_root.")
  }
  return target
}

function scoreSkill(skill: RuntimeSkill, queryTerms: string[]): number {
  const id = skill.id.toLowerCase()
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  let score = 0
  for (const term of queryTerms) {
    if (id === term || name === term) score += 100
    if (id.includes(term)) score += 40
    if (name.includes(term)) score += 30
    if (description.includes(term)) score += 10
  }
  return score
}

function normalizeSearch(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function unquote(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1)
  }
  return value
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20
  return Math.min(Math.max(1, Math.floor(limit)), 50)
}

function clampReadChars(maxChars: number): number {
  if (!Number.isFinite(maxChars)) return DEFAULT_MAX_READ_CHARS
  return Math.min(Math.max(1_000, Math.floor(maxChars)), MAX_READ_CHARS)
}
