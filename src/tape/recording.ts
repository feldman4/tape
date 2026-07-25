// Finalization logic: turns a raw RecordedTake into an immutable Clip in the
// Audio Pool. Free mode places audio directly (no stretching); Sync mode
// resamples the captured audio so its duration exactly matches the beats
// elapsed according to the external MIDI clock.

import { AudioPool } from '../audio/audioPool';
import type { Clip } from './model';

let clipCounter = 0;

export function finalizeFreeRecording(pool: AudioPool, samples: Float32Array, tapeStart: number): Clip {
  const audioBufferId = pool.add(samples);
  return {
    id: `clip-${clipCounter++}`,
    audioBufferId,
    tapeStart,
    sourceStart: 0,
    duration: samples.length,
  };
}

export function finalizeSyncRecording(
  pool: AudioPool,
  samples: Float32Array,
  tapeStart: number,
  beatsElapsed: number,
  samplesPerBeat: number,
): Clip {
  const targetLength = Math.max(0, Math.round(beatsElapsed * samplesPerBeat));
  const resampled = resampleLinear(samples, targetLength);
  const audioBufferId = pool.add(resampled);
  return {
    id: `clip-${clipCounter++}`,
    audioBufferId,
    tapeStart,
    sourceStart: 0,
    duration: resampled.length,
  };
}

/** Simple ratio-based linear resampling (duration correction only, no pitch preservation). */
export function resampleLinear(input: Float32Array, targetLength: number): Float32Array {
  if (targetLength <= 0 || input.length === 0) return new Float32Array(0);
  if (input.length === 1) return new Float32Array(targetLength).fill(input[0]);

  const output = new Float32Array(targetLength);
  const ratio = (input.length - 1) / Math.max(1, targetLength - 1);
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}
