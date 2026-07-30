// Canvas layout constants shared between TapePage and TapeTab.
export const CANVAS_WIDTH = 620;
export const CANVAS_HEIGHT = 134;  // TOP_BAND (14px) + 4 lanes (30px each)
// Default zoom: samples per pixel — 10 s visible at 44100 Hz across 620 px (≈5 bars at 120 BPM).
export const DEFAULT_SAMPLES_PER_PIXEL = Math.round((10 * 44100) / CANVAS_WIDTH);
