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

// ---------------------------------------------------------------------------
// Multi-beat onset measurement (metronome latency calibration)
// ---------------------------------------------------------------------------

export interface BeatOnsetResult {
  beatIndex: number;
  /** AudioContext frame corresponding to the MIDI-derived beat time. */
  expectedFrame: number;
  /** Detected onset frame in the recording (absolute AudioContext frame), or null. */
  detectedFrame: number | null;
  /** (detectedFrame − expectedFrame) / sampleRate × 1000 ms, or null if undetected. */
  offsetMs: number | null;
}

/**
 * For each MIDI beat context time, searches a window in a recording for an
 * onset transient and measures the offset from the expected beat position.
 *
 * Designed for OP-Z metronome calibration: each click is short, beats have
 * silence between them, and the OP-Z synthesis delay puts the audio a few
 * ms after the MIDI clock edge.
 *
 * @param samples             Raw recording buffer from the audio engine
 * @param recordStartFrame    AudioContext frame when recording began
 * @param beatContextTimesSecs  Per-beat AudioContext times (seconds), MIDI-latency-corrected
 * @param sampleRate
 * @param skipFirstBeats      Skip the first N beats (OP-Z clock / startup jitter)
 */
export function measureBeatOnsets(
  samples: Float32Array,
  recordStartFrame: number,
  beatContextTimesSecs: number[],
  sampleRate: number,
  skipFirstBeats = 1,
): BeatOnsetResult[] {
  // Search window: 2000 samples (~45 ms) before expected beat for noise floor,
  // 8000 samples (~181 ms) after for the onset.  Narrow enough not to bleed
  // into adjacent beats at ≥ 60 BPM.
  const BEFORE = 2000;
  const AFTER  = 8000;

  return beatContextTimesSecs.map((contextTimeSecs, i) => {
    const expectedFrame = Math.round(contextTimeSecs * sampleRate);
    const expectedInRec = expectedFrame - recordStartFrame;

    if (i < skipFirstBeats) {
      return { beatIndex: i, expectedFrame, detectedFrame: null, offsetMs: null };
    }

    const winStart = Math.max(0, expectedInRec - BEFORE);
    const winEnd   = Math.min(samples.length, expectedInRec + AFTER);
    if (winEnd <= winStart) {
      return { beatIndex: i, expectedFrame, detectedFrame: null, offsetMs: null };
    }

    const windowSlice = samples.slice(winStart, winEnd);
    // Pre-beat portion makes a good noise-floor reference.
    const preBeatLen   = Math.max(0, expectedInRec - winStart);
    const noiseFloor   = Math.max(64, Math.min(preBeatLen, 1500));
    const onset = detectOnset(windowSlice, noiseFloor);

    if (onset.index === null) {
      return { beatIndex: i, expectedFrame, detectedFrame: null, offsetMs: null };
    }

    const detectedFrame = recordStartFrame + winStart + onset.index;
    const offsetMs = ((detectedFrame - expectedFrame) / sampleRate) * 1000;
    return { beatIndex: i, expectedFrame, detectedFrame, offsetMs };
  });
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
