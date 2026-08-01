// Edit Engine — pure functions over Clip[].
// Every operation returns a new Clip[] (no mutation). The caller is responsible
// for pushing the previous clips to the undo stack before applying a change.
// Only joinClips requires a pool reference because it creates a new merged buffer.

import { makeClip, type Clip } from './model';
import type { AudioPool } from '../audio/audioPool';

let idCounter = 0;
function newClipId(): string {
  return `clip-${Date.now()}-${idCounter++}`;
}

// ---------------------------------------------------------------------------
// splitClip
// ---------------------------------------------------------------------------
/**
 * Splits `clip` at `tapeOffset` (a tape-absolute sample position).
 * Both halves reference the same audio buffer via sourceStart/duration sub-ranges.
 * Returns the full clips array with the original replaced by the two halves.
 * No-op if tapeOffset is not inside the clip.
 */
export function splitClip(clips: Clip[], clipId: string, tapeOffset: number): Clip[] {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return clips;
  const clip = clips[idx]!;

  const splitSamples = tapeOffset - clip.tapeStart;
  if (splitSamples <= 0 || splitSamples >= clip.duration) return clips;

  const left = makeClip(
    newClipId(),
    clip.audioBufferId,
    clip.tapeStart,
    clip.sourceStart,
    splitSamples,
  );
  left.gain = clip.gain;
  left.muted = clip.muted;

  const right = makeClip(
    newClipId(),
    clip.audioBufferId,
    clip.tapeStart + splitSamples,
    clip.sourceStart + splitSamples,
    clip.duration - splitSamples,
  );
  right.gain = clip.gain;
  right.muted = clip.muted;

  return [...clips.slice(0, idx), left, right, ...clips.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// deleteClip
// ---------------------------------------------------------------------------
export function deleteClip(clips: Clip[], clipId: string): Clip[] {
  return clips.filter((c) => c.id !== clipId);
}

// ---------------------------------------------------------------------------
// moveClip
// ---------------------------------------------------------------------------
/**
 * Moves a clip to a new tapeStart without allowing it to pass its neighbours.
 * Clips in a lane remain ordered and non-overlapping.
 */
export function moveClip(clips: Clip[], clipId: string, newTapeStart: number): Clip[] {
  const orderedClips = [...clips].sort((left, right) => left.tapeStart - right.tapeStart);
  const index = orderedClips.findIndex((clip) => clip.id === clipId);
  if (index === -1) return clips;

  const clip = orderedClips[index]!;
  const previous = orderedClips[index - 1];
  const next = orderedClips[index + 1];
  const minimumStart = previous ? previous.tapeStart + previous.duration : 0;
  const maximumStart = next ? Math.max(minimumStart, next.tapeStart - clip.duration) : Infinity;
  const boundedStart = Math.min(maximumStart, Math.max(minimumStart, newTapeStart));

  return clips.map((c) =>
    c.id === clipId ? { ...c, tapeStart: boundedStart } : c,
  );
}

// ---------------------------------------------------------------------------
// joinClips
// ---------------------------------------------------------------------------
/**
 * Joins two adjacent clips that share the same audio buffer into one.
 * If they don't share a buffer, creates a new merged buffer in the pool.
 * The clips must be adjacent (right.tapeStart === left.tapeStart + left.duration).
 * Returns updated clips array and a new pool.
 */
export function joinClips(
  clips: Clip[],
  id1: string,
  id2: string,
  pool: AudioPool,
): { clips: Clip[]; pool: AudioPool } {
  const c1 = clips.find((c) => c.id === id1);
  const c2 = clips.find((c) => c.id === id2);
  if (!c1 || !c2) return { clips, pool };

  // Ensure c1 comes before c2
  const [left, right] = c1.tapeStart <= c2.tapeStart ? [c1, c2] : [c2, c1];
  if (left.tapeStart + left.duration !== right.tapeStart) return { clips, pool };

  let merged: Clip;
  if (
    left.audioBufferId === right.audioBufferId &&
    left.sourceStart + left.duration === right.sourceStart
  ) {
    // Contiguous sub-ranges of the same buffer — no new buffer needed.
    merged = makeClip(
      newClipId(),
      left.audioBufferId,
      left.tapeStart,
      left.sourceStart,
      left.duration + right.duration,
    );
  } else {
    // Different buffers (or non-contiguous sub-ranges) — merge into new buffer.
    const leftSamples = pool.get(left.audioBufferId);
    const rightSamples = pool.get(right.audioBufferId);
    if (!leftSamples || !rightSamples) return { clips, pool };

    const combined = new Float32Array(left.duration + right.duration);
    combined.set(leftSamples.subarray(left.sourceStart, left.sourceStart + left.duration), 0);
    combined.set(rightSamples.subarray(right.sourceStart, right.sourceStart + right.duration), left.duration);
    const newId = pool.add(combined);
    merged = makeClip(newClipId(), newId, left.tapeStart, 0, combined.length);
  }
  merged.gain = left.gain;
  merged.muted = left.muted;

  const newClips = clips.filter((c) => c.id !== left.id && c.id !== right.id);
  newClips.splice(
    Math.min(
      clips.findIndex((c) => c.id === left.id),
      clips.findIndex((c) => c.id === right.id),
    ),
    0,
    merged,
  );
  return { clips: newClips, pool };
}

// ---------------------------------------------------------------------------
// liftClip
// ---------------------------------------------------------------------------
/** Removes a clip from the lane and returns it as "clipboard" content. */
export function liftClip(clips: Clip[], clipId: string): { clips: Clip[]; lifted: Clip | null } {
  const lifted = clips.find((c) => c.id === clipId) ?? null;
  if (!lifted) return { clips, lifted: null };
  return { clips: clips.filter((c) => c.id !== clipId), lifted };
}

// ---------------------------------------------------------------------------
// dropClip
// ---------------------------------------------------------------------------
/**
 * Inserts a clip (typically from the clipboard) at `newTapeStart`, overwriting
 * material in its range. Always assigns a fresh id so the dropped copy is a
 * new clip.
 */
export function dropClip(clips: Clip[], source: Clip, newTapeStart: number): Clip[] {
  const dropped: Clip = {
    ...source,
    id: newClipId(),
    tapeStart: Math.max(0, newTapeStart),
  };
  return applyOverwrite(clips, dropped);
}

// ---------------------------------------------------------------------------
// toggleMute
// ---------------------------------------------------------------------------
export function toggleMute(clips: Clip[], clipId: string): Clip[] {
  return clips.map((c) => (c.id === clipId ? { ...c, muted: !c.muted } : c));
}

// ---------------------------------------------------------------------------
// tapeLengthFromClips / tapeLengthFromLanes
// ---------------------------------------------------------------------------
/** Returns the sample position of the last sample across all clips in one lane. */
export function tapeLengthFromClips(clips: Clip[]): number {
  if (clips.length === 0) return 0;
  return Math.max(...clips.map((c) => c.tapeStart + c.duration));
}

import type { Tape } from './model';
/** Returns the sample position of the last sample across all four lanes. */
export function tapeLengthFromLanes(lanes: Tape['lanes']): number {
  const all = lanes.flatMap((l) => l.clips);
  if (all.length === 0) return 0;
  return Math.max(...all.map((c) => c.tapeStart + c.duration));
}

// ---------------------------------------------------------------------------
// applyOverwrite
// ---------------------------------------------------------------------------
/**
 * Applies destructive tape overwrite: inserts `newClip` into `clips` and
 * truncates or removes any existing clips whose tape range overlaps with it.
 *
 * Rules (all coordinates are sample positions):
 *  - Existing clip fully inside new clip → deleted.
 *  - Existing clip overlaps on the left only → right edge trimmed to newClip.tapeStart.
 *  - Existing clip overlaps on the right only → left edge advanced to newClip end;
 *    sourceStart adjusted accordingly.
 *  - Existing clip completely surrounds new clip → split into left and right tails.
 *
 * The returned array is sorted by tapeStart.
 */
export function applyOverwrite(clips: Clip[], newClip: Clip): Clip[] {
  const newStart = newClip.tapeStart;
  const newEnd   = newClip.tapeStart + newClip.duration;

  const result: Clip[] = [];

  for (const clip of clips) {
    const clipStart = clip.tapeStart;
    const clipEnd   = clip.tapeStart + clip.duration;

    // No overlap — keep untouched.
    if (clipEnd <= newStart || clipStart >= newEnd) {
      result.push(clip);
      continue;
    }

    // Left tail: the part of the existing clip that sits before the new clip.
    if (clipStart < newStart) {
      result.push({ ...clip, duration: newStart - clipStart });
    }

    // Right tail: the part of the existing clip that sits after the new clip.
    if (clipEnd > newEnd) {
      const trimSamples = newEnd - clipStart; // how far into the source we skip
      result.push({
        ...clip,
        id: newClipId(),
        tapeStart: newEnd,
        sourceStart: clip.sourceStart + trimSamples,
        duration: clipEnd - newEnd,
      });
    }

    // If neither tail exists the clip was fully overwritten — just drop it.
  }

  result.push(newClip);
  result.sort((a, b) => a.tapeStart - b.tapeStart);
  return result;
}
