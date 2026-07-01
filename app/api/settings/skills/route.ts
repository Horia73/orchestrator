import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile, type CurrentProfile } from "@/lib/profiles/server"
import {
  createCustomSkill,
  createCustomSkillFromContent,
  isWritableSkillScope,
  listSkillEntries,
  listSkills,
  publicSkill,
  writableSkillRoots,
} from "@/lib/skills/registry"
import type { WritableSkillScope } from "@/lib/skills/types"

const JSON_HEADERS = { "Cache-Control": "no-store" }
const MAX_REMOTE_SKILL_BYTES = 512_000

export async function GET(request: Request) {
  return runWithRequestProfile(request, (current) => {
    const activeById = new Map(listSkills().map((skill) => [skill.id, skill]))
    const skills = listSkillEntries().map((skill) => {
      const active = activeById.get(skill.id)
      return {
        ...publicSkill(skill),
        active: active?.root === skill.root,
        shadowedBy:
          active && active.root !== skill.root
            ? {
                scope: active.scope,
                source: active.source,
              }
            : null,
        writable:
          isWritableSkillScope(skill.scope) &&
          canManageSkillScope(current, skill.scope),
      }
    })
    const writableScopes = writableSkillRoots()
      .filter((root) => canManageSkillScope(current, root.scope))
      .map((root) => root.scope)
    return NextResponse.json(
      {
        skills,
        writableScopes,
        canManageProfileSkills: canManageSkillScope(current, "profile"),
        canManageGlobalSkills: canManageSkillScope(current, "global"),
      },
      { headers: JSON_HEADERS }
    )
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, (current) => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    return createSkillFromRequest(request, current)
  })
}

async function createSkillFromRequest(
  request: Request,
  current: CurrentProfile
): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400, headers: JSON_HEADERS }
    )
  }
  const parsed = body && typeof body === "object" ? body : {}
  const rawScope =
    "scope" in parsed && typeof parsed.scope === "string"
      ? parsed.scope
      : "profile"
  if (!isWritableSkillScope(rawScope)) {
    return NextResponse.json(
      { error: "Skill scope must be profile or global." },
      { status: 400, headers: JSON_HEADERS }
    )
  }
  if (!canManageSkillScope(current, rawScope)) {
    return NextResponse.json(
      { error: "Profile is not allowed to manage skills in this scope." },
      { status: 403, headers: JSON_HEADERS }
    )
  }
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : ""
  const description =
    "description" in parsed && typeof parsed.description === "string"
      ? parsed.description
      : ""
  const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : undefined
  const content =
    "content" in parsed && typeof parsed.content === "string"
      ? parsed.content
      : ""
  const sourceUrl =
    "sourceUrl" in parsed && typeof parsed.sourceUrl === "string"
      ? parsed.sourceUrl
      : ""
  try {
    const skillContent = content.trim()
      ? content
      : sourceUrl.trim()
        ? await fetchSkillMarkdown(sourceUrl)
        : ""
    const skill = skillContent.trim()
      ? createCustomSkillFromContent({
          scope: rawScope,
          id,
          content: skillContent,
        })
      : createCustomSkill({
          scope: rawScope,
          id,
          name,
          description,
        })
    return NextResponse.json(
      { success: true, skill: publicSkill(skill) },
      { headers: JSON_HEADERS }
    )
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create skill.",
      },
      { status: 400, headers: JSON_HEADERS }
    )
  }
}

async function fetchSkillMarkdown(rawUrl: string): Promise<string> {
  const url = normalizeSkillSourceUrl(rawUrl)
  const res = await fetch(url, {
    headers: {
      Accept: "text/markdown,text/plain,*/*;q=0.1",
      "User-Agent": "Orchestrator-Skills-Installer",
    },
  })
  if (!res.ok) {
    throw new Error(`Could not download SKILL.md (${res.status}).`)
  }
  return await readTextWithLimit(res)
}

function normalizeSkillSourceUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error("Source URL is not valid.")
  }
  if (url.protocol !== "https:") {
    throw new Error("Source URL must use HTTPS.")
  }
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean)
    const blobIndex = parts.indexOf("blob")
    if (parts.length >= 5 && blobIndex === 2) {
      const [owner, repo, , branch, ...fileParts] = parts
      url = new URL(
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileParts.join("/")}`
      )
    }
  }
  return url.toString()
}

async function readTextWithLimit(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_SKILL_BYTES) {
      throw new Error("SKILL.md is too large.")
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_REMOTE_SKILL_BYTES) {
      reader.cancel().catch(() => undefined)
      throw new Error("SKILL.md is too large.")
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(concatChunks(chunks, total))
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function canManageSkillScope(
  current: CurrentProfile,
  scope: WritableSkillScope
): boolean {
  if (scope === "global") return current.isAdmin
  return current.isAdmin || current.profile.permissions.tools.skills
}
