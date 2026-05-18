import { MULTIPURPOSE_CORE } from './core'
import { MULTIPURPOSE_DELEGATION } from './delegation'
import { MULTIPURPOSE_DELIVERABLES } from './deliverables'
import { MULTIPURPOSE_DOMAIN_PROTOCOLS } from './domain-protocols'
import { MULTIPURPOSE_EXAMPLES } from './examples'
import { MULTIPURPOSE_FILE_WORK } from './file-work'
import { MULTIPURPOSE_OUTPUT_CONTRACT } from './output-contract'
import { MULTIPURPOSE_QUALITY_CONTROL } from './quality-control'
import { MULTIPURPOSE_SKILLS } from './skills'
import { MULTIPURPOSE_TOOL_POLICY } from './tool-policy'
import { MULTIPURPOSE_WORKFLOW } from './workflow'

export const MULTIPURPOSE_PROMPT = [
    MULTIPURPOSE_CORE,
    MULTIPURPOSE_SKILLS,
    MULTIPURPOSE_TOOL_POLICY,
    MULTIPURPOSE_FILE_WORK,
    MULTIPURPOSE_WORKFLOW,
    MULTIPURPOSE_DELIVERABLES,
    MULTIPURPOSE_DOMAIN_PROTOCOLS,
    MULTIPURPOSE_DELEGATION,
    MULTIPURPOSE_QUALITY_CONTROL,
    MULTIPURPOSE_OUTPUT_CONTRACT,
    MULTIPURPOSE_EXAMPLES,
].filter(Boolean).join('\n\n')
