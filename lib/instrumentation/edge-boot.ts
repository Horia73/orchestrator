export async function registerRuntime(): Promise<void> {
  // The real boot hook is Node-only. This file keeps the Edge instrumentation
  // bundle free of Node APIs when Next also compiles instrumentation for proxy.
}
