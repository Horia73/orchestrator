import { CONCIERGE_BOOKING_COMMERCE } from './booking-commerce'
import { CONCIERGE_CONFIRMATION } from './confirmation'
import { CONCIERGE_CORE } from './core'
import { CONCIERGE_DELEGATION } from './delegation'
import { CONCIERGE_EXAMPLES } from './examples'
import { CONCIERGE_FOLLOWUP_MEMORY } from './followup-memory'
import { CONCIERGE_INTAKE } from './intake'
import { CONCIERGE_OPERATING_MODEL } from './operating-model'
import { CONCIERGE_OUTPUT_CONTRACT } from './output-contract'
import { CONCIERGE_QUALITY_CONTROL } from './quality-control'
import { CONCIERGE_SERVICE_PROTOCOLS } from './service-protocols'
import { CONCIERGE_TRAVEL_PROTOCOLS } from './travel-protocols'

export const CONCIERGE_PROMPT = [
    CONCIERGE_CORE,
    CONCIERGE_INTAKE,
    CONCIERGE_OPERATING_MODEL,
    CONCIERGE_DELEGATION,
    CONCIERGE_SERVICE_PROTOCOLS,
    CONCIERGE_TRAVEL_PROTOCOLS,
    CONCIERGE_BOOKING_COMMERCE,
    CONCIERGE_CONFIRMATION,
    CONCIERGE_FOLLOWUP_MEMORY,
    CONCIERGE_QUALITY_CONTROL,
    CONCIERGE_OUTPUT_CONTRACT,
    CONCIERGE_EXAMPLES,
].filter(Boolean).join('\n\n')
