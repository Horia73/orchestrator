import assert from "assert"
import fs from "fs"
import path from "path"

import { buildArtifactRepairPrompt } from "@/lib/ai/agents/artifact-repair"
import {
  buildAudioContextPrompt,
  buildAudioTranscriptAgentPrompt,
} from "@/lib/ai/agents/audio-context-agent"
import { buildConversationNamerPrompt } from "@/lib/ai/agents/conversation-namer"
import { buildSystemPrompt } from "@/lib/browser-agent-runtime/prompts"
import { CODER_PROMPT } from "@/lib/ai/prompts/coder"
import { CONCIERGE_PROMPT } from "@/lib/ai/prompts/concierge/index"
import { MODEL_METADATA_RESEARCHER_CORE } from "@/lib/ai/prompts/model-metadata-researcher"
import { buildOrchestratorStaticPrompt } from "@/lib/ai/prompts/orchestrator/index"
import { RESEARCHER_PROMPT } from "@/lib/ai/prompts/researcher/index"
import { WORKER_PROMPT } from "@/lib/ai/prompts/worker/index"
import {
  buildProviderMetadataResearchPrompt,
  buildSingleModelMetadataResearchPrompt,
} from "@/lib/ai/prompts/model-metadata-research"
import { OWNER_ASSISTANCE_POLICY } from "@/lib/ai/tools/owner-agent-help"
import { buildMarketsBriefPrompt } from "@/lib/monitoring/markets-heartbeat"
import { REFLECTION_PROMPT } from "@/lib/monitoring/memory-reflection-adapter"
import { CAPABILITY_AUDIT_PROMPT } from "@/lib/self-dev/capability-audit-adapter"
import {
  buildCustomSkillTemplate,
  validateSkillContent,
} from "@/lib/skills/registry"
import { buildSystemInstruction as buildVoiceSystemInstruction } from "@/lib/voice/live-session"

interface PromptContract {
  name: string
  value: string
  markers: string[]
  maxChars: number
}

function main() {
  const orchestrator = buildOrchestratorStaticPrompt({ bootActive: false })
  const browser = buildSystemPrompt(false, "normalized-viewport", true)
  const contracts: PromptContract[] = [
    {
      name: "orchestrator",
      value: orchestrator,
      markers: [
        "<role>",
        "<personality>",
        "<goal>",
        "<success_criteria>",
        "<constraints>",
        "<stop_rules>",
        "<output_contract>",
      ],
      maxChars: 80_000,
    },
    {
      name: "researcher",
      value: RESEARCHER_PROMPT,
      markers: ["<role>", "<goal>", "<success_criteria>", "<constraints>", "<stop_rules>", "<output_contract>"],
      maxChars: 30_000,
    },
    {
      name: "concierge",
      value: CONCIERGE_PROMPT,
      markers: ["<role>", "<personality>", "<goal>", "<success_criteria>", "<constraints>", "<stop_rules>", "<output_contract>"],
      maxChars: 38_000,
    },
    {
      name: "worker",
      value: WORKER_PROMPT,
      markers: ["<role>", "<goal>", "<success_criteria>", "<constraints>", "<stop_rules>", "<output_contract>"],
      maxChars: 5_000,
    },
    {
      name: "coder",
      value: CODER_PROMPT,
      markers: ["<role>", "<goal>", "<success_criteria>", "<constraints>", "<stop_rules>"],
      maxChars: 5_000,
    },
    {
      name: "model metadata researcher",
      value: MODEL_METADATA_RESEARCHER_CORE,
      markers: ["<role>", "<goal>", "<success_criteria>", "<constraints>", "<tools>", "<output>", "<stop_rules>"],
      maxChars: 5_000,
    },
    {
      name: "browser automation",
      value: browser,
      markers: ["## ROLE", "## GOAL", "## SUCCESS CRITERIA", "## Response Format - JSON ONLY"],
      maxChars: 34_000,
    },
  ]

  for (const contract of contracts) assertPromptContract(contract)

  assertOneShotContract("artifact repair", buildArtifactRepairPrompt())
  assertOneShotContract("audio context", buildAudioContextPrompt())
  assertOneShotContract("audio transcript", buildAudioTranscriptAgentPrompt())
  assertOneShotContract("conversation namer", buildConversationNamerPrompt())
  assertOneShotContract("markets monitor", buildMarketsBriefPrompt(["TEST crossed 1 → now 2"]))
  assertOneShotContract("memory reflection", REFLECTION_PROMPT)
  assertOneShotContract("capability audit", CAPABILITY_AUDIT_PROMPT)
  assertOneShotContract("voice", buildVoiceSystemInstruction())
  assertTaggedContract("owner assistance", OWNER_ASSISTANCE_POLICY)

  const modelStub = { name: "Test Model", kinds: ["text"] } as never
  assertTaggedContract(
    "provider metadata task",
    buildProviderMetadataResearchPrompt({
      providerId: "test",
      providerName: "Test",
      models: [{ modelId: "test-model", model: modelStub }],
    })
  )
  assertTaggedContract(
    "single-model metadata task",
    buildSingleModelMetadataResearchPrompt({
      providerId: "test",
      modelId: "test-model",
      model: modelStub,
    })
  )

  assert.ok(
    !orchestrator.includes("<worked_example>"),
    "production orchestrator prompt should not inject worked examples"
  )
  for (const file of [
    "lib/ai/prompts/orchestrator/examples.ts",
    "lib/ai/prompts/researcher/examples.ts",
    "lib/ai/prompts/concierge/examples.ts",
  ]) {
    assert.ok(!fs.existsSync(file), `${file} should stay removed`)
  }

  const starter = buildCustomSkillTemplate(
    "verified-workflow",
    "Verified Workflow",
    "Produce and validate a bounded workflow result."
  )
  validateSkillContent(starter)
  assert.ok(starter.includes("## Success criteria"))
  assert.ok(starter.includes("## Stop rules"))
  assert.ok(!starter.includes("Describe when the agent should use this skill"))

  const skillFiles = walk("skills").filter((file) => file.endsWith("/SKILL.md"))
  assert.ok(skillFiles.length > 0, "bundled skills should exist")
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, "utf8")
    const metadata = validateSkillContent(content)
    assert.strictEqual(
      metadata.name,
      path.basename(path.dirname(file)),
      `${file} name should match its directory`
    )
    assert.ok(
      !/^## (?:When to use|Use this skill when)/im.test(content),
      `${file} should keep triggering guidance in frontmatter`
    )
  }

  assert.ok(fs.existsSync("docs/prompting-standard.md"))
  console.log(
    `smoke-prompt-quality passed (${contracts.length} prompt packs, ${skillFiles.length} skills).`
  )
}

function assertPromptContract(contract: PromptContract) {
  for (const marker of contract.markers) {
    assert.ok(
      contract.value.includes(marker),
      `${contract.name} prompt should include ${marker}`
    )
  }
  assert.ok(
    contract.value.length <= contract.maxChars,
    `${contract.name} prompt should stay within ${contract.maxChars.toLocaleString()} chars (got ${contract.value.length.toLocaleString()})`
  )
}

function assertOneShotContract(name: string, value: string) {
  for (const marker of ["Role:", "Goal:", "Success"]) {
    assert.ok(value.includes(marker), `${name} prompt should include ${marker}`)
  }
}

function assertTaggedContract(name: string, value: string) {
  for (const marker of [
    "<role>",
    "<goal>",
    "<success_criteria>",
    "<constraints>",
    "<stop_rules>",
  ]) {
    assert.ok(value.includes(marker), `${name} prompt should include ${marker}`)
  }
}

function walk(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() ? [full.replace(/\\/g, "/")] : []
  })
}

main()
