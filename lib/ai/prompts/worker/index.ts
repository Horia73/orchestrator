import { WORKER_CORE } from './core'
import { WORKER_OUTPUT_CONTRACT } from './output-contract'

export const WORKER_PROMPT = [
    WORKER_CORE,
    WORKER_OUTPUT_CONTRACT,
].filter(Boolean).join('\n\n')
