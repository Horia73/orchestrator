import type { AgentConfig } from './types'
import { orchestrator } from './orchestrator'
import { researcher } from './researcher'
import { worker } from './worker'
import { coder } from './coder'
import { conciergeAgent } from './concierge-agent'
import { phoneAgent } from './phone-agent'
import { androidAgent } from './android-agent'
import { imageGenerator } from './image-generator'
import { videoGenerator } from './video-generator'
import { speechGenerator } from './speech-generator'
import { musicGenerator } from './music-generator'
import { browserAgent } from './browser-agent'
import { modelMetadataResearcher } from './model-metadata-researcher'
import { inboxAgent } from './inbox-agent'
import { smartMonitorAgent } from './smart-monitor-agent'
import { audioContextAgent } from './audio-context-agent'
import { conversationNamer } from './conversation-namer'
import { artifactRepairAgent } from './artifact-repair'

// ---------------------------------------------------------------------------
// Agent Registry
//
// The registered agent architecture. The registry encodes intended routing,
// settings UI, and observability shape so every surface sees the same agents.
// ---------------------------------------------------------------------------

const agents = new Map<string, AgentConfig>()

function register(agent: AgentConfig) {
    agents.set(agent.id, agent)
}

register(orchestrator)
register(researcher)
register(modelMetadataResearcher)
register(inboxAgent)
register(smartMonitorAgent)
register(audioContextAgent)
register(conversationNamer)
register(artifactRepairAgent)
register(worker)
register(coder)
register(conciergeAgent)
register(browserAgent)
register(phoneAgent)
register(androidAgent)
register(imageGenerator)
register(videoGenerator)
register(speechGenerator)
register(musicGenerator)

export function getAgent(id: string): AgentConfig | undefined {
    return agents.get(id)
}

export function getAllAgents(): AgentConfig[] {
    return Array.from(agents.values())
}
