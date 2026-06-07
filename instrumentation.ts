import { registerRuntime } from '#instrumentation-boot'

// Next also compiles instrumentation for Edge when proxy/middleware is present.
// The package import above resolves to a noop under the `edge-light` condition
// and to the real server boot module under Node.
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    await registerRuntime()
}
