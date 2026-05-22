import type { MonitorAction, MonitorRule } from './schema'

// ---------------------------------------------------------------------------
// Human-readable renderers for rules and actions. Pure; no I/O. Used by
//   - the wake brief that the orchestrator sees (lib/monitoring/smart-monitor.ts)
//   - the /monitor UI detail panel (Step 7)
//   - the orchestrator's monitor_* tools when echoing back what they did
// Keep one line per rule kind — the wake brief is read by the model in token
// budgets, so terse beats descriptive.
// ---------------------------------------------------------------------------

export function describeRule(rule: MonitorRule): string {
    switch (rule.kind) {
        case 'gmail_from':
            return `From contains: ${rule.senders.join(' OR ')}`
        case 'gmail_subject_contains':
            return `Subject contains: ${rule.substrings.join(' OR ')}${rule.caseInsensitive === false ? ' (case-sensitive)' : ''}`
        case 'gmail_label':
            return `Has Gmail label: ${rule.labels.join(' OR ')}`
        case 'gmail_query':
            return `Gmail search: ${rule.q}`

        case 'wa_from':
            return `WhatsApp from: ${rule.contacts.join(' OR ')}`
        case 'wa_text_contains':
            return `WhatsApp body contains: ${rule.substrings.join(' OR ')}`
        case 'wa_mention':
            return `WhatsApp mentions: ${rule.mentions.join(' OR ')}`

        case 'ha_state_equals':
            return `HA ${rule.entityId} state = "${rule.state}" (fires only on transition INTO that state)`
        case 'ha_state_changes':
            return `HA ${rule.entityId} state changes`
        case 'ha_attribute_changes':
            return `HA ${rule.entityId} attribute "${rule.attribute}" changes`
        case 'ha_threshold':
            return `HA ${rule.entityId} numeric ${rule.op} ${rule.value} (fires only on crossing)`

        case 'web_status':
            return `Web ${rule.url} HTTP status ${rule.op}${rule.value !== undefined ? ' ' + rule.value : ''}`
        case 'web_json_path':
            return `Web ${rule.url} JSON at "${rule.jsonPath}" ${rule.op}${rule.value !== undefined ? ' ' + JSON.stringify(rule.value) : ''}`
        case 'web_text_contains':
            return `Web ${rule.url} page text contains: ${rule.substrings.join(' OR ')}`

        case 'weather_precip_probability':
            return `Weather ${rule.location ?? 'target'} rain probability next ${rule.windowHours ?? 24}h ${rule.op} ${rule.value}%`
        case 'weather_temperature':
            return `Weather ${rule.location ?? 'target'} ${rule.metric} temperature ${rule.op} ${rule.value}°C`
        case 'weather_wind':
            return `Weather ${rule.location ?? 'target'} ${rule.metric} ${rule.op} ${rule.value} m/s`
        case 'weather_uv':
            return `Weather ${rule.location ?? 'target'} UV next ${rule.windowHours ?? 24}h ${rule.op} ${rule.value}`
        case 'weather_aqi':
            return `Weather ${rule.location ?? 'target'} AQI ${rule.op} ${rule.value}`
        case 'weather_condition':
            return `Weather ${rule.location ?? 'target'} condition in next ${rule.windowHours ?? 24}h: ${rule.conditions.join(' OR ')}`

        case 'any_of':
            return `ANY of: { ${rule.rules.map(describeRule).join(' | ')} }`
        case 'all_of':
            return `ALL of: { ${rule.rules.map(describeRule).join(' & ')} }`
    }
}

export function describeAction(action: MonitorAction): string {
    switch (action.kind) {
        case 'notify_inbox':
            return 'notify Inbox'
        case 'gmail_archive':
            return 'archive Gmail message'
        case 'gmail_mark_read':
            return 'mark Gmail message read'
        case 'gmail_label_add':
            return `add Gmail label "${action.label}"`
        case 'ha_call_service':
            return `call HA service ${action.domain}.${action.service}${action.fixedData ? ' with fixed args' : ''}`
        case 'wa_send_reply':
            return `reply on WhatsApp using template "${action.template.slice(0, 40)}${action.template.length > 40 ? '…' : ''}"`
    }
}
