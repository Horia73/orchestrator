import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { runWithRequestProfile, type CurrentProfile } from "@/lib/profiles/server"
import {
  deleteCustomSkill,
  isWritableSkillScope,
  publicSkill,
  readSkillEntry,
  readSkillFile,
  writeCustomSkillFile,
} from "@/lib/skills/registry"
import type { RuntimeSkillScope, WritableSkillScope } from "@/lib/skills/types"

const JSON_HEADERS = { "Cache-Control": "no-store" }

export async function GET(
  request: Request,
  { params }: { params: Promise<{ scope: string; id: string }> }
) {
  return runWithRequestProfile(request, async (current) => {
    const resolved = await resolveReadParams(params)
    if (resolved instanceof NextResponse) return resolved
    if (!canReadSkillScope(current, resolved.scope)) {
      return NextResponse.json(
        { error: "Profile is not allowed to read this skill." },
        { status: 403, headers: JSON_HEADERS }
      )
    }
    try {
      const skill = readSkillEntry(resolved.scope, resolved.id)
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

    const resolved = await resolveWritableParams(params)
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

    const resolved = await resolveWritableParams(params)
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

async function resolveReadParams(
  params: Promise<{ scope: string; id: string }>
): Promise<{ scope: RuntimeSkillScope; id: string } | NextResponse> {
  const resolved = await params
  if (!isSkillScope(resolved.scope)) {
    return NextResponse.json(
      { error: "Skill scope must be profile, global, or bundled." },
      { status: 400, headers: JSON_HEADERS }
    )
  }
  return { scope: resolved.scope, id: resolved.id }
}

async function resolveWritableParams(
  params: Promise<{ scope: string; id: string }>
): Promise<{ scope: WritableSkillScope; id: string } | NextResponse> {
  const resolved = await params
  if (!isWritableSkillScope(resolved.scope)) {
    return NextResponse.json(
      { error: "Only profile and global skills are editable." },
      { status: 400, headers: JSON_HEADERS }
    )
  }
  return { scope: resolved.scope, id: resolved.id }
}

function isSkillScope(value: string): value is RuntimeSkillScope {
  return value === "profile" || value === "global" || value === "bundled"
}

function canReadSkillScope(
  current: CurrentProfile,
  scope: RuntimeSkillScope
): boolean {
  if (scope === "bundled") return true
  return canManageSkillScope(current, scope)
}

function canManageSkillScope(
  current: CurrentProfile,
  scope: WritableSkillScope
): boolean {
  if (scope === "global") return current.isAdmin
  return current.isAdmin || current.profile.permissions.tools.skills
}
