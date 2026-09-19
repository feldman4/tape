// Finalization logic: turns a raw RecordedTake into an immutable Clip in the
// Audio Pool. Free mode places audio directly and can mix with existing clips
// (physical-tape overdub semantics). Sync mode also places directly without
// resampling — beat grid alignment is handled by precise recording placement
// via input/output latency calibration.
//
// Overdub (Free mode only):
//   When existingClips is supplied the finalized buffer is the SUM of the new
//   recording and any existing audio at those tape positions.  This gives
//   physical-tape semantics: recording writes onto the tape in place, so you
//   hear both what was there and what you just played.
//   Sync mode always replaces (no existingClips argument).

import { AudioPool } from '../audio/audioPool';
import { makeClip, type Clip } from './model';

let clipCounter = 0;
function nextId(): string { return `clip-${clipCounter++}`; }

/**
 * Mixes audio from existing clips into `buffer` at positions that overlap the
 * buffer’s tape range `[clipTapeStart, clipTapeStart + buffer.length)`.
 * Respects clip gain; skips muted clips.
 */
function mixExistingAudio(
  buffer: Float32Array,
  clipTapeStart: number,
  existingClips: Clip[],
  pool: AudioPool,
): void {
  const bufEnd = clipTapeStart + buffer.length;
  for (const clip of existingClips) {
    const clipEnd = clip.tapeStart + clip.duration;
    const overlapStart = Math.max(clip.tapeStart, clipTapeStart);
    const overlapEnd   = Math.min(clipEnd, bufEnd);
    if (overlapStart >= overlapEnd) continue;

    const samples = pool.get(clip.audioBufferId);
    if (!samples) continue;
    if (clip.muted) continue;

    const gain = clip.gain;
    for (let tapePos = overlapStart; tapePos < overlapEnd; tapePos++) {
      const bufIdx = tapePos - clipTapeStart;
      const srcIdx = clip.sourceStart + (tapePos - clip.tapeStart);
      buffer[bufIdx] += (samples[srcIdx] ?? 0) * gain;
    }
  }
}

export function finalizeFreeRecording(
  pool: AudioPool,
  samples: Float32Array,
  tapeStart: number,
  existingClips?: Clip[],
): Clip {
  // Copy so we can mix into the buffer without touching the worklet’s transfer.
  const result = new Float32Array(samples);
  if (existingClips && existingClips.length > 0) {
    mixExistingAudio(result, tapeStart, existingClips, pool);
  }
  const audioBufferId = pool.add(result);
  return makeClip(nextId(), audioBufferId, tapeStart, 0, result.length);
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
  existingClips?: Clip[],
  rotateSamples = 0,
): Clip {
  const loopLen = loopOut - loopIn;
  const tapeStart = Math.min(recordStart, loopIn);
  const clipLen = loopOut - tapeStart;
  const result = new Float32Array(clipLen); // zero-filled

  // Fold new recording passes into result (last write wins within this take).
  for (let i = 0; i < samples.length; i++) {
    const linearPos = recordStart + i;
    const tapePos = linearPos < loopIn
      ? linearPos                                          // pre-loop: written once
      : loopIn + (linearPos - loopIn) % loopLen;          // in-loop: last write wins
    result[tapePos - tapeStart] = samples[i]!;
  }

  // Overdub: mix in whatever was already on the tape at this region.
  if (existingClips && existingClips.length > 0) {
    mixExistingAudio(result, tapeStart, existingClips, pool);
  }

  if (rotateSamples !== 0 && result.length > 0) {
    const shift = ((rotateSamples % result.length) + result.length) % result.length;
    if (shift !== 0) {
      const rotated = new Float32Array(result.length);
      rotated.set(result.subarray(0, result.length - shift), shift);
      rotated.set(result.subarray(result.length - shift), 0);
      const audioBufferId = pool.add(rotated);
      return makeClip(nextId(), audioBufferId, tapeStart, 0, clipLen);
    }
  }

  const audioBufferId = pool.add(result);
  return makeClip(nextId(), audioBufferId, tapeStart, 0, clipLen);
}
