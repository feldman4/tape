// Loopback latency self-test: schedules a click on the output while
// recording, then locates the click in the recorded buffer via
// normalized cross-correlation against the known click waveform template.
// The difference between when the click was scheduled and when it was
// detected is the measured round-trip latency (output -> interface -> input).

import { CLICK_LENGTH, createClickWaveform } from './clickWaveform';

const TEMPLATE = createClickWaveform();
let templateEnergy = 0;
for (let i = 0; i < CLICK_LENGTH; i++) templateEnergy += TEMPLATE[i] * TEMPLATE[i];

/** Normalized cross-correlation (Pearson-style) at a given offset: 1.0 is a perfect
 * match regardless of recording volume, ~0 is no correlation (noise). */
function normalizedScore(recorded: Float32Array, start: number): number {
  let dot = 0;
  let recordedEnergy = 0;
  for (let i = 0; i < CLICK_LENGTH; i++) {
    const sample = recorded[start + i];
    dot += sample * TEMPLATE[i];
    recordedEnergy += sample * sample;
  }
  const denom = Math.sqrt(recordedEnergy * templateEnergy);
  return denom > 0 ? dot / denom : 0;
}

/** Returns the sample index in `recorded` where the click template best matches. */
export function detectClickOffset(recorded: Float32Array): number {
  let bestScore = -Infinity;
  let bestIndex = 0;
  const lastStart = recorded.length - CLICK_LENGTH;
  for (let start = 0; start <= lastStart; start++) {
    const score = normalizedScore(recorded, start);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = start;
    }
  }
  return bestIndex;
}

export interface LatencyResult {
  latencyMs: number;
  /** Normalized cross-correlation at the detected offset, from -1 to 1. Above
   * ~0.6 is a solid match; below that, treat the measurement as unreliable
   * (too quiet, too noisy, or the click wasn't picked up at all). */
  confidence: number;
}

export function measureLatency(
  recorded: Float32Array,
  recordStartFrame: number,
  clickAtFrame: number,
  sampleRate: number,
): LatencyResult {
  const offsetIndex = detectClickOffset(recorded);
  const detectedFrame = recordStartFrame + offsetIndex;
  const latencyFrames = detectedFrame - clickAtFrame;
  const confidence = normalizedScore(recorded, offsetIndex);
  return { latencyMs: (latencyFrames / sampleRate) * 1000, confidence };
}
