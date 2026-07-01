import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile, type CurrentProfile } from "@/lib/profiles/server"
import {
  createCustomSkill,
  isWritableSkillScope,
  listSkillEntries,
  listSkills,
  publicSkill,
  writableSkillRoots,
} from "@/lib/skills/registry"
import type { WritableSkillScope } from "@/lib/skills/types"

const JSON_HEADERS = { "Cache-Control": "no-store" }

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
  try {
    const skill = createCustomSkill({
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

export function canManageSkillScope(
  current: CurrentProfile,
  scope: WritableSkillScope
): boolean {
  if (scope === "global") return current.isAdmin
  return current.isAdmin || current.profile.permissions.tools.skills
}
