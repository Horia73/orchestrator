import assert from "assert"
import fs from "fs"
import os from "os"
import path from "path"

import { coder } from "@/lib/ai/agents/coder"
import { orchestrator } from "@/lib/ai/agents/orchestrator"
import { resolveRuntimeAgentConfig } from "@/lib/ai/agents/runtime-agent-config"
import { worker } from "@/lib/ai/agents/worker"
import { DELEGATING_WORKSPACE_TOOLS } from "@/lib/ai/agents/builtins"
import {
  executeActivateSkill,
  executeReadSkillFile,
  executeSkillSearch,
} from "@/lib/ai/tools/skills"
import { getToolExecutor } from "@/lib/ai/tools/executors/registry"
import { getTool } from "@/lib/ai/tools/registry"
import {
  buildCustomSkillTemplate,
  findSkill,
  isWritableSkillScope,
  listSkillFiles,
  listSkills,
  promoteLegacyProfileSkillsToGlobal,
  readSkillFile,
  validateSkillContent,
  writableSkillRoots,
} from "@/lib/skills/registry"
import { buildSkillsIndex } from "@/lib/skills/prompt"

const EXPECTED_SKILLS = [
  {
    id: "pptx",
    query: "presentation deck",
    expectedSearchTerm: ".pptx",
    requiredFiles: ["editing.md", "pptxgenjs.md"],
    runtimeNeedle: "$SKILL_ROOT/scripts/office/soffice.py",
    includeFile: "editing.md",
  },
  {
    id: "docx",
    query: "word document memo",
    expectedSearchTerm: ".docx",
    requiredFiles: ["scripts/accept_changes.py", "scripts/office/validate.py"],
    runtimeNeedle: "$SKILL_ROOT/scripts/office/soffice.py",
    includeFile: "SKILL.md",
  },
  {
    id: "xlsx",
    query: "spreadsheet excel csv",
    expectedSearchTerm: "spreadsheet",
    requiredFiles: ["scripts/recalc.py", "scripts/office/validate.py"],
    runtimeNeedle: "$SKILL_ROOT/scripts/recalc.py",
    includeFile: "SKILL.md",
  },
  {
    id: "pdf",
    query: "pdf form ocr",
    expectedSearchTerm: "PDF",
    requiredFiles: ["forms.md", "reference.md", "scripts/fill_fillable_fields.py"],
    runtimeNeedle: "$SKILL_ROOT/scripts/check_fillable_fields.py",
    includeFile: "forms.md",
  },
  {
    id: "theme-factory",
    query: "apply theme to deck",
    expectedSearchTerm: "theme",
    requiredFiles: ["theme-showcase.pdf", "themes/ocean-depths.md"],
    runtimeNeedle: "theme-showcase.pdf",
    includeFile: "themes/ocean-depths.md",
  },
  {
    id: "internal-comms",
    query: "leadership status update",
    expectedSearchTerm: "internal communications",
    requiredFiles: ["examples/3p-updates.md", "examples/general-comms.md"],
    runtimeNeedle: "examples/3p-updates.md",
    includeFile: "examples/general-comms.md",
  },
  {
    id: "frontend-design",
    query: "build a polished standalone dashboard",
    expectedSearchTerm: "standalone",
    requiredFiles: ["LICENSE.txt"],
    runtimeNeedle: "Orchestrator UI",
    includeFile: "SKILL.md",
  },
  {
    id: "data-analytics",
    query: "analyze business metrics and data quality",
    expectedSearchTerm: "structured data",
    requiredFiles: [
      "references/data-quality.md",
      "references/metric-diagnostics.md",
      "references/visualization-and-reporting.md",
    ],
    runtimeNeedle: "application/vnd.ant.react",
    includeFile: "references/data-quality.md",
  },
  {
    id: "incident-investigation",
    query: "debug a stuck failed runtime flow",
    expectedSearchTerm: "stuck",
    requiredFiles: ["references/diagnostic-ladder.md"],
    runtimeNeedle: 'ActivateIntegrationTools("observability")',
    includeFile: "references/diagnostic-ladder.md",
  },
  {
    id: "product-design-audit",
    query: "audit ux product flow screenshots",
    expectedSearchTerm: "product flow",
    requiredFiles: ["references/audit-framework.md"],
    runtimeNeedle: "browser_agent",
    includeFile: "references/audit-framework.md",
  },
]

async function main() {
  const skills = listSkills()
  assertSkillAuthoringContract()
  assertNoProviderNativeSkillLeaks()
  assert.deepStrictEqual(
    writableSkillRoots().map((root) => root.scope),
    ["global"],
    "custom skills should only be writable in the global scope"
  )
  assert.strictEqual(isWritableSkillScope("global"), true, "global should be writable")
  assert.strictEqual(isWritableSkillScope("profile"), false, "profile skills should be legacy read-only")

  assertLegacyProfileSkillMigration()

  for (const expected of EXPECTED_SKILLS) {
    const skill = findSkill(expected.id)
    assert.ok(skill, `${expected.id} skill should be installed`)
    assert.ok(
      skills.some((candidate) => candidate.id === expected.id),
      `${expected.id} should be listed`
    )
    assert.strictEqual(skill?.scope, "bundled", `${expected.id} should be bundled`)
    assert.ok(
      skill?.description.includes(expected.expectedSearchTerm),
      `${expected.id} description should be parsed`
    )

    const skillMd = readSkillFile(skill!, "SKILL.md")
    assert.ok(skillMd.content.includes("Orchestrator Runtime"), `${expected.id} has runtime section`)
    assert.ok(
      skillMd.content.includes(expected.runtimeNeedle),
      `${expected.id} should use runtime-safe helper paths`
    )

    const fileIndex = listSkillFiles(skill!)
    for (const file of expected.requiredFiles) {
      assert.ok(fileIndex.includes(file), `${expected.id} should index ${file}`)
    }

    const search = await executeSkillSearch({ query: expected.query })
    assert.strictEqual(search.success, true, `SkillSearch should succeed for ${expected.id}`)
    const searchData = search.data as { skills: Array<{ id: string }> }
    assert.ok(
      searchData.skills.some((candidate) => candidate.id === expected.id),
      `SkillSearch should find ${expected.id} for ${expected.query}`
    )

    const activation = await executeActivateSkill({
      skill: expected.id,
      include_files: [expected.includeFile],
      max_chars_per_file: 20_000,
    })
    assert.strictEqual(activation.success, true, `ActivateSkill should succeed for ${expected.id}`)
    const activationData = activation.data as {
      skill_root: string
      skill_md: { content: string }
      files: Array<{ path: string; content: string }>
    }
    assert.ok(
      activationData.skill_root.replace(/\\/g, "/").endsWith(`/skills/${expected.id}`),
      `${expected.id} skill_root should point at bundled skill`
    )
    assert.ok(activationData.skill_md.content.includes("Orchestrator Runtime"), `${expected.id} returns SKILL.md`)
    assert.strictEqual(
      activationData.files[0]?.path,
      expected.includeFile,
      `${expected.id} ActivateSkill reads include_files`
    )
  }

  const pptxRead = await executeReadSkillFile({ skill: "pptx", path: "pptxgenjs.md" })
  assert.strictEqual(pptxRead.success, true, "ReadSkillFile should succeed")
  assert.ok(JSON.stringify(pptxRead.data).includes("pptxgenjs"), "ReadSkillFile should return file content")

  const pdfRead = await executeReadSkillFile({ skill: "pdf", path: "forms.md" })
  assert.strictEqual(pdfRead.success, true, "ReadSkillFile should succeed for pdf forms")
  assert.ok(JSON.stringify(pdfRead.data).includes("fill_fillable_fields"), "ReadSkillFile should return pdf forms content")

  const pdfSkill = findSkill("pdf")
  assert.ok(pdfSkill, "pdf skill should be installed")
  const pdfSkillMd = readSkillFile(pdfSkill!, "SKILL.md")
  assert.ok(pdfSkillMd.content.includes("Visual QA"), "PDF skill should require visual QA")
  assert.ok(pdfSkillMd.content.includes("pdftoppm -png -r 150"), "PDF visual QA should render pages")

  const themeRead = await executeReadSkillFile({ skill: "theme-factory", path: "themes/ocean-depths.md" })
  assert.strictEqual(themeRead.success, true, "ReadSkillFile should succeed for theme files")
  assert.ok(JSON.stringify(themeRead.data).includes("Ocean Depths"), "ReadSkillFile should return theme content")

  const commsRead = await executeReadSkillFile({ skill: "internal-comms", path: "examples/general-comms.md" })
  assert.strictEqual(commsRead.success, true, "ReadSkillFile should succeed for internal comms examples")
  assert.ok(JSON.stringify(commsRead.data).includes("communication"), "ReadSkillFile should return internal comms content")

  const frontendSkill = findSkill("frontend-design")
  assert.ok(frontendSkill, "frontend-design skill should be installed")
  const frontendSkillMd = readSkillFile(frontendSkill!, "SKILL.md")
  for (const needle of [
    'ActivateIntegrationTools("media")',
    "exactly three",
    "image_generator",
    "unavailable or fails",
    "selection",
    "browser_agent",
  ]) {
    assert.ok(
      frontendSkillMd.content.includes(needle),
      `frontend-design should include visual-first workflow clause: ${needle}`
    )
  }

  const pptx = findSkill("pptx")
  assert.ok(pptx, "pptx skill should be installed")
  assert.throws(
    () => readSkillFile(pptx!, "../package.json"),
    /escapes skill_root/,
    "skill file reads must not escape skill_root"
  )

  for (const id of ["SkillSearch", "ActivateSkill", "ReadSkillFile"]) {
    assert.ok(getTool(id), `${id} should be registered`)
    assert.ok(getToolExecutor(id), `${id} should have an executor`)
    assert.ok(orchestrator.tools.includes(id), `orchestrator should expose ${id}`)
    assert.ok(worker.tools.includes(id), `worker should expose ${id}`)
    assert.ok(!coder.tools.includes(id), `registered CLI coder should not expose ${id}`)
    assert.ok(!DELEGATING_WORKSPACE_TOOLS.includes(id), `${id} should not be in generic delegating tools`)
  }

  const cliCoder = resolveRuntimeAgentConfig(coder, "claude-code")
  assert.strictEqual(cliCoder.buildPrompt, undefined, "CLI coder should remain promptless")
  for (const id of ["SkillSearch", "ActivateSkill", "ReadSkillFile"]) {
    assert.ok(!cliCoder.tools.includes(id), `CLI coder should not expose ${id}`)
  }

  const apiCoder = resolveRuntimeAgentConfig(coder, "openai")
  assert.ok(apiCoder.buildPrompt, "API coder should receive a prompt builder")
  for (const id of ["SkillSearch", "ActivateSkill", "ReadSkillFile"]) {
    assert.ok(apiCoder.tools.includes(id), `API coder should expose ${id}`)
  }

  assert.ok(
    worker.canCallAgents?.includes("worker"),
    "worker should retain self-delegation escape hatch"
  )

  const promptIndex = buildSkillsIndex()
  assert.ok(promptIndex.includes("<skills_index>"), "prompt should include skills_index")
  assert.ok(
    promptIndex.includes("Do not read provider-native skill folders"),
    "prompt skills_index should forbid provider-native skill path probing"
  )
  assert.ok(
    promptIndex.includes("Orchestrator global skills root"),
    "prompt skills_index should route skill installs to the global root"
  )
  for (const expected of EXPECTED_SKILLS) {
    assert.ok(promptIndex.includes(expected.id), `prompt skills_index should mention ${expected.id}`)
  }
  assert.ok(!promptIndex.includes("# PPTX Skill"), "prompt index should not inline SKILL.md")

  const delegateToSource = fs.readFileSync("lib/ai/tools/delegate-to.ts", "utf8")
  assert.ok(
    delegateToSource.includes("<orchestrator_cli_coder_runtime>") &&
      delegateToSource.includes("/app/.orchestrator/.../.codex/skills"),
    "CLI coder delegation should inject guidance against native skill path probing"
  )

  const codexProviderSource = fs.readFileSync("lib/ai/providers/codex.ts", "utf8")
  assert.ok(
    codexProviderSource.includes("features.skills=false") &&
      codexProviderSource.includes("even for plain coder runs"),
    "Codex native coder runs should explicitly disable Codex-native skills"
  )

  const dockerfile = fs.readFileSync("Dockerfile", "utf8")
  const runnerStage = dockerfile.split("FROM node:22-bookworm-slim AS runner")[1] ?? ""
  for (const needle of [
    "pandoc",
    "libreoffice-writer",
    "libreoffice-calc",
    "qpdf",
    "tesseract-ocr",
    "markitdown[pptx]",
    "pdfplumber",
    "pdf2image",
    "pypdfium2",
    "reportlab",
    "pytesseract",
  ]) {
    assert.ok(dockerfile.includes(needle), `Dockerfile should include ${needle}`)
  }
  for (const needle of ["usermod --uid 1002", "groupmod --gid 1002", "g++", "make", "pkg-config"]) {
    assert.ok(runnerStage.includes(needle), `Dockerfile runner stage should include ${needle}`)
  }

  const installScript = fs.readFileSync("scripts/install.sh", "utf8")
  for (const needle of ["pdfplumber", "qpdf", "tesseract", "pandoc", "libreoffice-calc"]) {
    assert.ok(installScript.includes(needle), `install.sh should include ${needle}`)
  }

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
  }
  for (const dep of ["docx", "pptxgenjs", "pdf-lib"]) {
    assert.ok(pkg.dependencies?.[dep], `package.json should include ${dep}`)
  }

  console.log(`smoke-skills passed (${skills.length} installed skill${skills.length === 1 ? "" : "s"}).`)
}

function assertSkillAuthoringContract() {
  const starter = buildCustomSkillTemplate(
    "incident-response",
    "Incident Response",
    "Investigate incidents and produce a verified recovery report."
  )
  const metadata = validateSkillContent(starter)
  assert.strictEqual(metadata.name, "incident-response")
  assert.strictEqual(
    metadata.description,
    "Investigate incidents and produce a verified recovery report."
  )
  for (const heading of [
    "## Goal",
    "## Success criteria",
    "## Workflow",
    "## Constraints",
    "## Output",
    "## Stop rules",
  ]) {
    assert.ok(starter.includes(heading), `starter skill should include ${heading}`)
  }
  assert.ok(!/^id:/m.test(starter), "starter should use portable frontmatter")
  assert.ok(
    !starter.includes("Describe when the agent should use this skill"),
    "starter should not ship placeholder instructions"
  )

  assert.throws(
    () => validateSkillContent("# Missing frontmatter"),
    /YAML frontmatter/
  )
  assert.throws(
    () =>
      validateSkillContent(
        "---\nname: Incident Response\ndescription: Test\n---\n\n# Test"
      ),
    /hyphen-case/
  )
  assert.throws(
    () =>
      validateSkillContent(
        `---\nname: too-long\ndescription: Test\n---\n\n${Array.from({ length: 501 }, (_, index) => `line ${index}`).join("\n")}`
      ),
    /500 lines or less/
  )
}

function assertLegacyProfileSkillMigration() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orch-skill-migrate-"))
  try {
    const profileDir = path.join(base, "profile-skills")
    const globalDir = path.join(base, "global-skills")

    // A unique legacy profile skill → should move up to global.
    writeSkillFixture(profileDir, "legacy-drafting", "Legacy Drafting", "draft 2d plans")
    // An id already owned globally → the legacy copy must be left untouched.
    writeSkillFixture(profileDir, "dup-skill", "Dup Skill", "profile copy")
    writeSkillFixture(globalDir, "dup-skill", "Dup Skill", "global copy")
    // A stray non-skill directory (no SKILL.md) → ignored.
    fs.mkdirSync(path.join(profileDir, "not-a-skill"), { recursive: true })

    const first = promoteLegacyProfileSkillsToGlobal({
      profileSkillsDir: profileDir,
      globalSkillsDir: globalDir,
    })
    assert.deepStrictEqual(first.moved, ["legacy-drafting"], "unique legacy skill should move to global")
    assert.deepStrictEqual(first.skipped, ["dup-skill"], "colliding legacy skill should be skipped")
    assert.ok(
      fs.existsSync(path.join(globalDir, "legacy-drafting", "SKILL.md")),
      "migrated skill should exist in the global root"
    )
    assert.ok(
      !fs.existsSync(path.join(profileDir, "legacy-drafting")),
      "migrated skill should be removed from the profile root"
    )
    assert.ok(
      fs.existsSync(path.join(profileDir, "dup-skill", "SKILL.md")),
      "colliding legacy skill must be left in place (not deleted)"
    )
    assert.ok(
      fs.readFileSync(path.join(globalDir, "dup-skill", "SKILL.md"), "utf8").includes("global copy"),
      "existing global skill must not be overwritten by the legacy copy"
    )

    // Idempotent: a second run moves nothing new and still reports the collision.
    const second = promoteLegacyProfileSkillsToGlobal({
      profileSkillsDir: profileDir,
      globalSkillsDir: globalDir,
    })
    assert.deepStrictEqual(second.moved, [], "second run should move nothing")
    assert.deepStrictEqual(second.skipped, ["dup-skill"], "second run should still report the collision")
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

function writeSkillFixture(rootDir: string, id: string, name: string, description: string) {
  const dir = path.join(rootDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nid: ${id}\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8"
  )
}

function assertNoProviderNativeSkillLeaks() {
  const forbidden = [
    /\bClaude\b/,
    /\bclaude\.ai\b/i,
    // Provider names can be legitimate factual/legal research or license
    // provenance. Reject provider-native operational surfaces, not the bare
    // company name in content that a skill is meant to analyze.
    /\bAnthropic (?:MCP|tool|skill|plugin)\b/i,
    /\bCODEX_HOME\b/,
    /\.codex\b/,
    /\bartifact-tool\b/,
    /\bGoogle Slides\b/,
  ]
  const offenders: string[] = []

  for (const file of walkFiles("skills")) {
    if (file.endsWith("/LICENSE.txt") || file.endsWith("\\LICENSE.txt")) continue
    const content = fs.readFileSync(file, "utf8")
    const matched = forbidden.find((pattern) => pattern.test(content))
    if (matched) offenders.push(`${file}: ${matched}`)
  }

  assert.deepStrictEqual(
    offenders,
    [],
    "Bundled skill runtime instructions should not leak provider-native/Claude-specific wording"
  )
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = `${root}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath))
    } else if (entry.isFile()) {
      out.push(fullPath)
    }
  }
  return out
}

main().catch((err) => {
  console.error("smoke-skills failed")
  console.error(err)
  process.exit(1)
})
