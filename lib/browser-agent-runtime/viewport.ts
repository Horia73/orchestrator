export const DEFAULT_VIEWPORT = {
    width: 1920,
    height: 1080,
} as const;

/**
 * Viewport presets the agent can switch between with the `setViewport` action.
 * Sizes track common device classes; `desktop` restores the default viewport.
 */
export const VIEWPORT_PRESETS = {
    mobile: { width: 390, height: 844 },
    tablet: { width: 820, height: 1180 },
    desktop: DEFAULT_VIEWPORT,
} as const;

export type ViewportPreset = keyof typeof VIEWPORT_PRESETS;
