// Canvas layout constants shared between TapePage and TapeTab.
export const CANVAS_WIDTH = 620;
export const CANVAS_HEIGHT = 134;  // TOP_BAND (14px) + 4 lanes (30px each)

// View width constants
// Default: five 4/4 bars, regardless of tempo.
export const DEFAULT_VIEW_BEATS = 20;
// Minimum zoom-in: 2 seconds visible
export const MIN_VIEW_WIDTH_SAMPLES = 2 * 44100;
// Margin when zooming to loop: a two-bar loop matches the default view at 120 BPM.
export const VIEW_MARGIN = 0.25;

export function defaultViewWidthSamples(bpm: number, sampleRate = 44100): number {
	return Math.round(DEFAULT_VIEW_BEATS * (sampleRate * 60) / bpm);
}

// Keep for backward compat with existing imports at the 120 BPM default.
export const DEFAULT_SAMPLES_PER_PIXEL = Math.round(defaultViewWidthSamples(120) / CANVAS_WIDTH);
