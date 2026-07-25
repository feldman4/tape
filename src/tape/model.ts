// Minimal Tape/Clip data model (Stage 0: single lane only).
// See docs/starting_plan.md section 5 for the full multi-lane model
// this will grow into during Stage 1.

import type { AudioBufferId } from '../audio/audioPool';

export interface Clip {
  id: string;
  audioBufferId: AudioBufferId;
  tapeStart: number; // sample position on tape
  sourceStart: number; // offset into source buffer, samples
  duration: number; // samples
}

export interface Lane {
  clips: Clip[];
}
