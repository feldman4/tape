// Tape/Clip data model — four-lane tape recorder.
// See docs/starting_plan.md section 5 for the full model description.

import type { AudioBufferId } from '../audio/audioPool';

export interface Clip {
  id: string;
  audioBufferId: AudioBufferId;
  tapeStart: number;   // sample position on tape where clip begins
  sourceStart: number; // offset into source buffer, samples
  duration: number;    // samples
  gain: number;        // default 1.0
  muted: boolean;
}

export interface Lane {
  clips: Clip[];
  muted: boolean;
  gain: number;  // 0.0–2.0, default 1.0
  pan:  number;  // -1.0 (L) to 1.0 (R), default 0.0
}

export const LANE_COUNT = 4;

export interface Tape {
  lanes: [Lane, Lane, Lane, Lane];
  activeLane: 0 | 1 | 2 | 3;   // which lane is active for recording/editing
  tapeLength: number;    // total tape length in samples (grows as clips are added)
  playhead: number;      // current tape position in samples
  loopIn: number;        // loop start in samples
  loopOut: number;       // loop end in samples
  loopEnabled: boolean;
  bpm: number;           // project tempo in BPM (integer); default 120
}

// 8 beats at 120 BPM / 44100 Hz = default loop out for new sessions (2 bars).
const DEFAULT_LOOP_OUT_SAMPLES = Math.round(8 * (44100 * 60) / 120); // 176400

export function makeDefaultTape(): Tape {
  return {
    lanes: [
      { clips: [], muted: false, gain: 1.0, pan: 0.0 },
      { clips: [], muted: false, gain: 1.0, pan: 0.0 },
      { clips: [], muted: false, gain: 1.0, pan: 0.0 },
      { clips: [], muted: false, gain: 1.0, pan: 0.0 },
    ],
    activeLane: 0,
    tapeLength: 0,
    playhead: 0,
    loopIn: 0,
    loopOut: DEFAULT_LOOP_OUT_SAMPLES,
    loopEnabled: true,
    bpm: 120,
  };
}

export function makeClip(
  id: string,
  audioBufferId: AudioBufferId,
  tapeStart: number,
  sourceStart: number,
  duration: number,
): Clip {
  return { id, audioBufferId, tapeStart, sourceStart, duration, gain: 1.0, muted: false };
}
