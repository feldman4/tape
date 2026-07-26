// Finalization logic: turns a raw RecordedTake into an immutable Clip in the
// Audio Pool. Free mode places audio directly (no stretching); Sync mode
// resamples the captured audio so its duration exactly matches the beats
// elapsed according to the external MIDI clock.

import { AudioPool } from '../audio/audioPool';
import { makeClip, type Clip } from './model';

let clipCounter = 0;
function nextId(): string { return `clip-${clipCounter++}`; }

export function finalizeFreeRecording(pool: AudioPool, samples: Float32Array, tapeStart: number): Clip {
  const audioBufferId = pool.add(samples);
  return makeClip(nextId(), audioBufferId, tapeStart, 0, samples.length);
}

/**
 * Finalizes a loop-overdub recording using last-pass-wins semantics.
 *
 * `samples` is the raw linear capture starting at `recordStart` on the tape.
 * Positions before `loopIn` are written once (pre-loop).  Once the linear
 * position hits `loopIn`, it wraps around [loopIn, loopOut) on each pass;
 * later passes overwrite earlier ones so the most-recently-played audio wins.
 *
 * The resulting clip spans from min(recordStart, loopIn) to loopOut.
 */
export function finalizeLoopRecording(
  pool: AudioPool,
  samples: Float32Array,
  recordStart: number,
  loopIn: number,
  loopOut: number,
): Clip {
  const loopLen = loopOut - loopIn;
  const tapeStart = Math.min(recordStart, loopIn);
  const clipLen = loopOut - tapeStart;
  const result = new Float32Array(clipLen); // zero-filled

  for (let i = 0; i < samples.length; i++) {
    const linearPos = recordStart + i;
    const tapePos = linearPos < loopIn
      ? linearPos                                          // pre-loop: written once
      : loopIn + (linearPos - loopIn) % loopLen;          // in-loop: last write wins
    result[tapePos - tapeStart] = samples[i]!;
  }

  const audioBufferId = pool.add(result);
  return makeClip(nextId(), audioBufferId, tapeStart, 0, clipLen);
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
  return makeClip(nextId(), audioBufferId, tapeStart, 0, resampled.length);
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
