/**
 * Smoke test for the live voice mode plumbing (pure logic, no network):
 *   - VoiceSettings normalization: defaults, domain-list hygiene, and the
 *     invariant that security domains can never be un-blocked by config.
 *   - Home Assistant voice guard: allowlist, blocklist, entity/domain
 *     mismatch refusals.
 *   - Live-model ranking: newest version wins, flash preferred, and the
 *     fallback chain stays live-only.
 *   - Client wire protocol parsing rejects junk without throwing.
 *
 * Run: npx tsx scripts/smoke-voice.ts
 */
import {
    defaultVoiceSettings,
    evaluateVoiceHaCall,
    normalizeVoiceSettings,
    parseVoiceClientMessage,
    pickBestLiveModel,
    VOICE_LIVE_MODEL_FALLBACKS,
} from '@/lib/voice/schema'

let failures = 0

function check(name: string, condition: boolean) {
    if (condition) {
        console.log(`  ok - ${name}`)
    } else {
        failures += 1
        console.error(`  FAIL - ${name}`)
    }
}

console.log('voice settings normalization:')
{
    const defaults = normalizeVoiceSettings(undefined)
    check('defaults enable voice', defaults.enabled)
    check('defaults use auto model', defaults.model === 'auto')
    check('defaults block lock domain', defaults.homeAssistant.blockedDomains.includes('lock'))

    const custom = normalizeVoiceSettings({
        enabled: false,
        model: ' gemini-3.1-flash-live-preview ',
        voiceName: 'Puck',
        homeAssistant: {
            allowedDomains: ['Light', 'INVALID DOMAIN!', 'switch'],
            blockedDomains: [],
        },
        rooms: [
            { id: 'living', name: 'Living', input: 'esphome', output: 'sonos-audioclip', sonosHost: '10.0.0.5' },
            { id: '', name: 'broken' },
        ],
    })
    check('explicit disable respected', !custom.enabled)
    check('model trimmed', custom.model === 'gemini-3.1-flash-live-preview')
    check('invalid domains dropped', custom.homeAssistant.allowedDomains.join(',') === 'light,switch')
    check(
        'security blocklist survives empty config',
        custom.homeAssistant.blockedDomains.includes('lock') &&
            custom.homeAssistant.blockedDomains.includes('alarm_control_panel')
    )
    check('valid room kept, broken room dropped', custom.rooms.length === 1 && custom.rooms[0].output === 'sonos-audioclip')
}

console.log('home assistant voice guard:')
{
    const policy = defaultVoiceSettings().homeAssistant
    check(
        'light control allowed',
        evaluateVoiceHaCall(policy, 'light', ['light.living_room']).allowed
    )
    check(
        'lock service refused',
        !evaluateVoiceHaCall(policy, 'lock', ['lock.front_door']).allowed
    )
    check(
        'cross-domain smuggling refused (light service, lock entity)',
        !evaluateVoiceHaCall(policy, 'light', ['lock.front_door']).allowed
    )
    check(
        'unlisted domain refused',
        !evaluateVoiceHaCall(policy, 'water_heater', ['water_heater.boiler']).allowed
    )
    check('missing domain refused', !evaluateVoiceHaCall(policy, '', []).allowed)
}

console.log('live model ranking:')
{
    check(
        'newest version wins',
        pickBestLiveModel([
            'gemini-2.0-flash-live-001',
            'gemini-live-2.5-flash-preview',
            'gemini-3.1-flash-live-preview',
        ]) === 'gemini-3.1-flash-live-preview'
    )
    check(
        'flash preferred over pro at same version',
        pickBestLiveModel(['gemini-3.1-pro-live-preview', 'gemini-3.1-flash-live-preview']) ===
            'gemini-3.1-flash-live-preview'
    )
    check('non-live ids rejected', pickBestLiveModel(['gemini-3-flash-preview']) === null)
    check(
        'specialized live variants excluded (real catalog fixture)',
        pickBestLiveModel([
            'gemini-2.5-flash-native-audio-latest',
            'gemini-2.5-flash-native-audio-preview-09-2025',
            'gemini-2.5-flash-native-audio-preview-12-2025',
            'gemini-3.1-flash-live-preview',
            'gemini-3.5-live-translate-preview',
        ]) === 'gemini-3.1-flash-live-preview'
    )
    check(
        'translate-only catalog yields null instead of a wrong pick',
        pickBestLiveModel(['gemini-3.5-live-translate-preview']) === null
    )
    check('models/ prefix stripped', pickBestLiveModel(['models/gemini-2.0-flash-live-001']) === 'gemini-2.0-flash-live-001')
    check(
        'fallback chain is live-only',
        VOICE_LIVE_MODEL_FALLBACKS.every((id) => id.includes('live'))
    )
}

console.log('wire protocol parsing:')
{
    check('start parses', parseVoiceClientMessage('{"type":"start"}')?.type === 'start')
    const withRoom = parseVoiceClientMessage('{"type":"start","roomId":" living "}')
    check('room id trimmed', withRoom?.type === 'start' && withRoom.roomId === 'living')
    check('end parses', parseVoiceClientMessage('{"type":"end"}')?.type === 'end')
    check('junk rejected quietly', parseVoiceClientMessage('not json') === null)
    check('unknown type rejected', parseVoiceClientMessage('{"type":"nope"}') === null)
}

if (failures > 0) {
    console.error(`\nsmoke:voice FAILED (${failures} assertion(s))`)
    process.exit(1)
}
console.log('\nsmoke:voice passed')
