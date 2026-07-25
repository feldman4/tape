// Onset detection for the OP-Z note-to-sound latency test. Unlike the
// internal loopback click test (clickWaveform.ts/latencyTest.ts), the
// waveform of an OP-Z percussion hit isn't known in advance, so we can't
// cross-correlate against a template. Instead this uses a short-time-energy
// threshold: measure the noise floor at the start of the recording (before
// the note was sent), then scan forward for the first window whose RMS
// clears that floor by a wide margin.

const WINDOW_SIZE = 64;
const THRESHOLD_MULTIPLIER = 6; // onset window RMS must exceed the noise floor by this factor
const MIN_ABSOLUTE_THRESHOLD = 0.01; // guards against a near-silent noise floor triggering on tiny noise

export interface OnsetResult {
  index: number | null; // sample index of the detected onset, or null if nothing crossed the threshold
  noiseFloorRms: number;
  peakRms: number;
}

/** Finds the first transient in `samples` that clearly exceeds the leading noise floor. */
export function detectOnset(samples: Float32Array, noiseFloorSamples = 2048): OnsetResult {
  const floorLen = Math.min(noiseFloorSamples, samples.length);
  let noiseSum = 0;
  for (let i = 0; i < floorLen; i++) noiseSum += samples[i] * samples[i];
  const noiseFloorRms = Math.sqrt(noiseSum / Math.max(1, floorLen));
  const threshold = Math.max(noiseFloorRms * THRESHOLD_MULTIPLIER, MIN_ABSOLUTE_THRESHOLD);

  let peakRms = 0;
  for (let start = 0; start + WINDOW_SIZE <= samples.length; start += WINDOW_SIZE) {
    let sum = 0;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / WINDOW_SIZE);
    if (rms > peakRms) peakRms = rms;
    if (rms >= threshold) {
      // Refine to the first sample in this window whose absolute value clears the threshold.
      for (let i = 0; i < WINDOW_SIZE; i++) {
        if (Math.abs(samples[start + i]) >= threshold) {
          return { index: start + i, noiseFloorRms, peakRms };
        }
      }
      return { index: start, noiseFloorRms, peakRms };
    }
  }
  return { index: null, noiseFloorRms, peakRms };
}

export interface NoteLatencyResult extends OnsetResult {
  latencyMs: number | null;
}

/**
 * Measures note-to-sound latency: the time from sending a MIDI note to the
 * OP-Z until its audio onset appears in the recording. Includes the OP-Z's
 * own internal trigger latency plus USB MIDI/audio transport latency - see
 * docs/testing_proposal.md "Audio Interface".
 */
export function measureNoteLatency(
  recorded: Float32Array,
  recordStartFrame: number,
  sentFrame: number,
  sampleRate: number,
): NoteLatencyResult {
  const onset = detectOnset(recorded);
  if (onset.index === null) return { ...onset, latencyMs: null };
  const detectedFrame = recordStartFrame + onset.index;
  const latencyMs = ((detectedFrame - sentFrame) / sampleRate) * 1000;
  return { ...onset, latencyMs };
}
