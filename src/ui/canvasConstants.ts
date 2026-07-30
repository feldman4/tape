// Canvas layout constants shared between TapePage and TapeTab.
export const CANVAS_WIDTH = 620;
export const CANVAS_HEIGHT = 134;  // TOP_BAND (14px) + 4 lanes (30px each)

// View width constants (in samples)
// Default: 10 seconds visible at 44100 Hz (≈5 bars at 120 BPM)
export const DEFAULT_VIEW_WIDTH_SAMPLES = 10 * 44100;
// Minimum zoom-in: 2 seconds visible
export const MIN_VIEW_WIDTH_SAMPLES = 2 * 44100;
// Margin when zooming to loop: adds extra space around loop edges (5% extra on each side)
export const VIEW_MARGIN = 0.05;

// Keep for backward compat with existing imports
export const DEFAULT_SAMPLES_PER_PIXEL = Math.round(DEFAULT_VIEW_WIDTH_SAMPLES / CANVAS_WIDTH);
