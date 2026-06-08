import assert from "assert"
import fs from "fs"

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
  findSkill,
  listSkillFiles,
  listSkills,
  readSkillFile,
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
]

async function main() {
  const skills = listSkills()
  assertNoProviderNativeSkillLeaks()

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
  for (const expected of EXPECTED_SKILLS) {
    assert.ok(promptIndex.includes(expected.id), `prompt skills_index should mention ${expected.id}`)
  }
  assert.ok(!promptIndex.includes("# PPTX Skill"), "prompt index should not inline SKILL.md")

  const dockerfile = fs.readFileSync("Dockerfile", "utf8")
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

function assertNoProviderNativeSkillLeaks() {
  const forbidden = [
    /\bClaude\b/,
    /\bclaude\.ai\b/i,
    /\bAnthropic\b/,
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
