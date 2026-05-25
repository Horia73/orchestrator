/**
 * Synthesized chime for recipe timer completion.
 *
 * Generated at runtime via Web Audio API — no audio asset to ship, no
 * royalty/license to worry about, and the user gets sub-millisecond latency
 * from `playChime()` to the first sample.
 *
 * Browsers gate AudioContext behind a user gesture: a context created outside
 * a click handler may start suspended and never play. We lazily construct the
 * context on first call (which is itself inside a click handler — the user
 * starts a timer by clicking the chip) and resume it as needed.
 */

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
    if (typeof window === "undefined") return null
    if (ctx) {
        if (ctx.state === "suspended") void ctx.resume()
        return ctx
    }
    type AudioCtor = typeof AudioContext
    const Ctor: AudioCtor | undefined =
        (window as unknown as { AudioContext?: AudioCtor }).AudioContext
        ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
    if (!Ctor) return null
    try {
        ctx = new Ctor()
        if (ctx.state === "suspended") void ctx.resume()
        return ctx
    } catch {
        return null
    }
}

/**
 * Some browsers (Safari especially) hold the AudioContext suspended until a
 * user gesture. Call this inside the click handler that starts a timer so the
 * later, gesture-less call to {@link playChime} from the countdown tick will
 * be allowed to make sound.
 */
export function primeAudio(): void {
    getCtx()
}

/**
 * Play a friendly 3-tone ascending chime (~600ms total). Safe to call from
 * any context — silently no-ops in SSR or browsers without Web Audio.
 *
 * The notes are a D-major triad (D5, F#5, A5) which lands as cheerful
 * without being startling. Each note has a fast attack and a softer decay
 * so they overlap into a chord-like sustain.
 */
export function playChime(): void {
    const audio = getCtx()
    if (!audio) return

    const now = audio.currentTime
    const notes: Array<{ freq: number; start: number; dur: number }> = [
        { freq: 587.33, start: 0.00, dur: 0.18 },  // D5
        { freq: 739.99, start: 0.10, dur: 0.22 },  // F#5
        { freq: 880.00, start: 0.22, dur: 0.34 },  // A5
    ]

    for (const note of notes) {
        const osc = audio.createOscillator()
        const gain = audio.createGain()
        osc.type = "sine"
        osc.frequency.value = note.freq

        // ADSR-like envelope: 8ms attack, hold at 0.18 gain, exponential decay.
        const t0 = now + note.start
        const t1 = t0 + 0.008
        const t2 = t0 + note.dur
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.exponentialRampToValueAtTime(0.18, t1)
        gain.gain.exponentialRampToValueAtTime(0.0001, t2)

        osc.connect(gain).connect(audio.destination)
        osc.start(t0)
        osc.stop(t2 + 0.02)
    }
}
