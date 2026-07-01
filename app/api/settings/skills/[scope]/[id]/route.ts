import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile, type CurrentProfile } from "@/lib/profiles/server"
import {
  deleteCustomSkill,
  isWritableSkillScope,
  publicSkill,
  readCustomSkill,
  readSkillFile,
  writeCustomSkillFile,
} from "@/lib/skills/registry"
import type { WritableSkillScope } from "@/lib/skills/types"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export async function GET(
  request: Request,
  { params }: { params: Promise<{ scope: string; id: string }> }
) {
  return runWithRequestProfile(request, async (current) => {
    const resolved = await resolveParams(params)
    if (resolved instanceof NextResponse) return resolved
    if (!canManageSkillScope(current, resolved.scope)) {
      return NextResponse.json(
        { error: "Profile is not allowed to read this skill." },
        { status: 403, headers: JSON_HEADERS }
      )
    }
    try {
      const skill = readCustomSkill(resolved.scope, resolved.id)
      const file = readSkillFile(skill, "SKILL.md")
      return NextResponse.json(
        { skill: publicSkill(skill), file },
        { headers: JSON_HEADERS }
      )
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Skill not found." },
        { status: 404, headers: JSON_HEADERS }
      )
    }
  })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ scope: string; id: string }> }
) {
  return runWithRequestProfile(request, async (current) => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const resolved = await resolveParams(params)
    if (resolved instanceof NextResponse) return resolved
    if (!canManageSkillScope(current, resolved.scope)) {
      return NextResponse.json(
        { error: "Profile is not allowed to edit this skill." },
        { status: 403, headers: JSON_HEADERS }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400, headers: JSON_HEADERS }
      )
    }
    const content =
      body && typeof body === "object" && "content" in body
        ? body.content
        : undefined
    if (typeof content !== "string") {
      return NextResponse.json(
        { error: "Missing string content." },
        { status: 400, headers: JSON_HEADERS }
      )
    }

    try {
      const skill = writeCustomSkillFile(resolved.scope, resolved.id, content)
      return NextResponse.json(
        { success: true, skill: publicSkill(skill) },
        { headers: JSON_HEADERS }
      )
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Failed to save skill.",
        },
        { status: 400, headers: JSON_HEADERS }
      )
    }
  })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ scope: string; id: string }> }
) {
  return runWithRequestProfile(request, async (current) => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const resolved = await resolveParams(params)
    if (resolved instanceof NextResponse) return resolved
    if (!canManageSkillScope(current, resolved.scope)) {
      return NextResponse.json(
        { error: "Profile is not allowed to delete this skill." },
        { status: 403, headers: JSON_HEADERS }
      )
    }

    try {
      deleteCustomSkill(resolved.scope, resolved.id)
      return NextResponse.json({ success: true }, { headers: JSON_HEADERS })
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to delete skill.",
        },
        { status: 400, headers: JSON_HEADERS }
      )
    }
  })
}

async function resolveParams(
  params: Promise<{ scope: string; id: string }>
): Promise<{ scope: WritableSkillScope; id: string } | NextResponse> {
  const resolved = await params
  if (!isWritableSkillScope(resolved.scope)) {
    return NextResponse.json(
      { error: "Skill scope must be profile or global." },
      { status: 400, headers: JSON_HEADERS }
    )
  }
  return { scope: resolved.scope, id: resolved.id }
}

function canManageSkillScope(
  current: CurrentProfile,
  scope: WritableSkillScope
): boolean {
  if (scope === "global") return current.isAdmin
  return current.isAdmin || current.profile.permissions.tools.skills
}
