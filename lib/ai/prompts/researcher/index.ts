import { RESEARCHER_CORE } from './core'
import { RESEARCHER_DELEGATION } from './delegation'
import { RESEARCHER_DOMAIN_PROTOCOLS } from './domain-protocols'
import { RESEARCHER_EVIDENCE_POLICY } from './evidence-policy'
import { RESEARCHER_EXAMPLES } from './examples'
import { RESEARCHER_OUTPUT_CONTRACT } from './output-contract'
import { RESEARCHER_QUALITY_CONTROL } from './quality-control'
import { RESEARCHER_QUERY_STRATEGY } from './query-strategy'
import { RESEARCHER_SOURCE_POLICY } from './source-policy'
import { RESEARCHER_WORKFLOW } from './workflow'

export const RESEARCHER_PROMPT = [
    RESEARCHER_CORE,
    RESEARCHER_WORKFLOW,
    RESEARCHER_QUERY_STRATEGY,
    RESEARCHER_SOURCE_POLICY,
    RESEARCHER_EVIDENCE_POLICY,
    RESEARCHER_DOMAIN_PROTOCOLS,
    RESEARCHER_DELEGATION,
    RESEARCHER_QUALITY_CONTROL,
    RESEARCHER_OUTPUT_CONTRACT,
    RESEARCHER_EXAMPLES,
].filter(Boolean).join('\n\n')
