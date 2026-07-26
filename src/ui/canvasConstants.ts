// Canvas layout constants shared between TapePage and TapeTab.
export const CANVAS_WIDTH = 620;
export const CANVAS_HEIGHT = 200;
// Default zoom: samples per pixel — 20 s visible at 44100 Hz across 620 px.
export const DEFAULT_SAMPLES_PER_PIXEL = Math.round((20 * 44100) / CANVAS_WIDTH);
